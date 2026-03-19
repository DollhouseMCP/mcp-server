/**
 * Get content details from collection
 */


import { GitHubClient } from './GitHubClient.js';
import { PersonaMetadata } from '../types/persona.js';
import { ContentValidator } from '../security/contentValidator.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { SecurityError } from '../errors/SecurityError.js';

export class PersonaDetails {
  private githubClient: GitHubClient;
  private baseUrl = 'https://api.github.com/repos/DollhouseMCP/collection/contents';
  
  constructor(githubClient: GitHubClient) {
    this.githubClient = githubClient;
  }
  
  /**
   * Get detailed information about collection content
   */
  async getCollectionContent(path: string): Promise<{ metadata: PersonaMetadata; content: string }> {
    const url = `${this.baseUrl}/${path}`;
    
    const data = await this.githubClient.fetchFromGitHub(url);
    
    if (data.type !== 'file') {
      throw new Error('Path does not point to a file');
    }
    
    // Decode Base64 content
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    
    // Sanitize content for display (this is view-only, not installation)
    const sanitizedContent = ContentValidator.sanitizePersonaContent(content);
    
    // Use secure YAML parser
    let parsed;
    try {
      parsed = SecureYamlParser.safeMatter(sanitizedContent);
    } catch (error) {
      if (error instanceof SecurityError) {
        throw new Error(`Security warning: This content contains potentially malicious content - ${error.message}`);
      }
      throw error;
    }
    
    const metadata = parsed.data as PersonaMetadata;
    
    // Additional validation for display
    const metadataValidation = ContentValidator.validateMetadata(metadata);
    if (!metadataValidation.isValid && metadataValidation.severity === 'critical') {
      throw new Error(`Security warning: This content contains potentially malicious content`);
    }
    
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
      `${personaIndicator}🎭 **Collection Content: ${metadata.name}**\n\n`,
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
      `Use: \`install_collection_content "${path}"\`\n\n`,
      `**📄 Full Content:**\n\`\`\`\n${content}\n\`\`\``
    );
    
    return textParts.join('');
  }
}