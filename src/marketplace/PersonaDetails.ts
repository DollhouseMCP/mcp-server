/**
 * Get persona details from marketplace
 */

import matter from 'gray-matter';
import { GitHubClient } from './GitHubClient.js';
import { PersonaMetadata } from '../types/persona.js';

export class PersonaDetails {
  private githubClient: GitHubClient;
  private baseUrl = 'https://api.github.com/repos/DollhouseMCP/personas/contents/personas';
  
  constructor(githubClient: GitHubClient) {
    this.githubClient = githubClient;
  }
  
  /**
   * Get detailed information about a marketplace persona
   */
  async getMarketplacePersona(path: string): Promise<{ metadata: PersonaMetadata; content: string }> {
    const url = `${this.baseUrl}/${path}`;
    
    const data = await this.githubClient.fetchFromGitHub(url);
    
    if (data.type !== 'file') {
      throw new Error('Path does not point to a file');
    }
    
    // Decode Base64 content
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    const parsed = matter(content);
    const metadata = parsed.data as PersonaMetadata;
    
    return {
      metadata,
      content: parsed.content
    };
  }
  
  /**
   * Format persona details for display
   */
  formatPersonaDetails(metadata: PersonaMetadata, content: string, path: string, personaIndicator: string = ''): string {
    const textParts = [
      `${personaIndicator}🎭 **Marketplace Persona: ${metadata.name}**\n\n`,
      `**📋 Details:**\n`,
      `   🆔 ID: ${metadata.unique_id || 'Not specified'}\n`,
      `   👤 Author: ${metadata.author || 'Unknown'}\n`,
      `   📁 Category: ${metadata.category || 'General'}\n`,
      `   🔖 Price: ${metadata.price || 'Free'}\n`,
      `   📊 Version: ${metadata.version || '1.0'}\n`,
      `   🔞 Age Rating: ${metadata.age_rating || 'All'}\n`,
      `   ${metadata.ai_generated ? '🤖 AI Generated' : '👤 Human Created'}\n\n`,
      `**📝 Description:**\n${metadata.description}\n\n`
    ];
    
    if (metadata.triggers && metadata.triggers.length > 0) {
      textParts.push(`**🔗 Triggers:** ${metadata.triggers.join(', ')}\n\n`);
    }
    
    textParts.push(
      `**📥 Installation:**\n`,
      `Use: \`install_persona "${path}"\`\n\n`,
      `**📄 Full Content:**\n\`\`\`\n${content}\n\`\`\``
    );
    
    return textParts.join('');
  }
}