/**
 * Install personas from marketplace
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import matter from 'gray-matter';
import { GitHubClient } from './GitHubClient.js';
import { PersonaMetadata } from '../types/persona.js';
import { validatePath, validateFilename, validateContentSize } from '../security/InputValidator.js';
import { SECURITY_LIMITS } from '../security/constants.js';

export class PersonaInstaller {
  private githubClient: GitHubClient;
  private personasDir: string;
  private baseUrl = 'https://api.github.com/repos/DollhouseMCP/personas/contents/personas';
  
  constructor(githubClient: GitHubClient, personasDir: string) {
    this.githubClient = githubClient;
    this.personasDir = personasDir;
  }
  
  /**
   * Install a persona from the marketplace
   */
  async installPersona(inputPath: string): Promise<{ 
    success: boolean; 
    message: string;
    metadata?: PersonaMetadata;
    filename?: string;
  }> {
    // Validate and sanitize the input path
    const sanitizedPath = validatePath(inputPath);
    
    // Ensure the path ends with .md
    if (!sanitizedPath.endsWith('.md')) {
      throw new Error('Invalid file type. Only .md files are allowed.');
    }
    
    const url = `${this.baseUrl}/${sanitizedPath}`;
    const data = await this.githubClient.fetchFromGitHub(url);
    
    if (data.type !== 'file') {
      throw new Error('Path does not point to a file');
    }
    
    // Check file size before downloading
    if (data.size > SECURITY_LIMITS.MAX_PERSONA_SIZE_BYTES) {
      throw new Error(`File too large (${data.size} bytes, max ${SECURITY_LIMITS.MAX_PERSONA_SIZE_BYTES} bytes)`);
    }
    
    // Decode Base64 content
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    
    // Validate content size after decoding
    validateContentSize(content, SECURITY_LIMITS.MAX_PERSONA_SIZE_BYTES);
    
    const parsed = matter(content);
    const metadata = parsed.data as PersonaMetadata;
    
    // Validate metadata
    if (!metadata.name || !metadata.description) {
      throw new Error('Invalid persona: missing required name or description');
    }
    
    // Generate and validate local filename
    const originalFilename = sanitizedPath.split('/').pop() || 'downloaded-persona.md';
    const filename = validateFilename(originalFilename);
    const localPath = path.join(this.personasDir, filename);
    
    // Check if file already exists
    try {
      await fs.access(localPath);
      return {
        success: false,
        message: `Persona already exists: ${filename}\n\nUse \`reload_personas\` to refresh if you've updated it manually.`
      };
    } catch {
      // File doesn't exist, proceed with installation
    }
    
    // Write the file
    await fs.writeFile(localPath, content, 'utf-8');
    
    return {
      success: true,
      message: `Persona installed successfully!`,
      metadata,
      filename
    };
  }
  
  /**
   * Format installation success message
   */
  formatInstallSuccess(metadata: PersonaMetadata, filename: string, totalPersonas: number, personaIndicator: string = ''): string {
    return `${personaIndicator}✅ **Persona Installed Successfully!**\n\n` +
      `🎭 **${metadata.name}** by ${metadata.author}\n` +
      `📁 Saved as: ${filename}\n` +
      `📊 Total personas: ${totalPersonas}\n\n` +
      `🎯 **Ready to use:** \`activate_persona "${metadata.name}"\``;
  }
}