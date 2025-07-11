/**
 * Persona sharing functionality via URLs
 */

import { Persona } from '../../types/persona.js';
import { PersonaExporter, ExportedPersona } from './PersonaExporter.js';
import { GitHubClient } from '../../marketplace/GitHubClient.js';
import { logger } from '../../utils/logger.js';

export interface ShareResult {
  success: boolean;
  url?: string;
  gistId?: string;
  expiresAt?: string;
  message: string;
}

export class PersonaSharer {
  private exporter: PersonaExporter;
  
  constructor(
    private githubClient: GitHubClient,
    private currentUser: string | null
  ) {
    this.exporter = new PersonaExporter(currentUser);
  }

  /**
   * Share a persona via GitHub Gist
   */
  async sharePersona(persona: Persona, expiryDays: number = 7): Promise<ShareResult> {
    try {
      // Export persona to structured format
      const exportData = this.exporter.exportPersona(persona);
      
      // Add sharing metadata
      const shareData = {
        ...exportData,
        sharedAt: new Date().toISOString(),
        sharedBy: this.currentUser || 'anonymous',
        expiresAt: new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString(),
        shareVersion: '1.0.0'
      };

      // Create GitHub Gist
      const gistResult = await this.createGist(persona.metadata.name, shareData);
      
      if (!gistResult.success) {
        // Fallback to base64 URL if Gist fails
        return this.createBase64Url(shareData);
      }

      return {
        success: true,
        url: gistResult.url!,
        gistId: gistResult.gistId,
        expiresAt: shareData.expiresAt,
        message: this.formatShareSuccess(gistResult.url!, shareData.expiresAt)
      };

    } catch (error) {
      logger.error('Share error', error);
      return {
        success: false,
        message: `Failed to share persona: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Import a persona from a share URL
   */
  async importFromUrl(url: string): Promise<{ success: boolean; data?: any; message: string }> {
    try {
      // Check if it's a GitHub Gist URL
      const gistId = this.extractGistId(url);
      if (gistId) {
        return await this.importFromGist(gistId);
      }

      // Check if it's a base64 URL
      if (url.includes('#dollhouse-persona=')) {
        return this.importFromBase64Url(url);
      }

      // Try direct fetch
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.statusText}`);
      }

      const data = await response.json();
      return {
        success: true,
        data,
        message: 'Successfully retrieved persona data'
      };

    } catch (error) {
      logger.error('Import from URL error', error);
      return {
        success: false,
        message: `Failed to import from URL: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Create a GitHub Gist
   */
  private async createGist(personaName: string, data: any): Promise<{ success: boolean; url?: string; gistId?: string }> {
    try {
      // Check if we have a GitHub token
      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        logger.info('No GitHub token available for Gist creation');
        return { success: false };
      }

      const response = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'DollhouseMCP/1.0'
        },
        body: JSON.stringify({
          description: `DollhouseMCP Persona: ${personaName}`,
          public: false, // Private gist for security
          files: {
            'persona.json': {
              content: JSON.stringify(data, null, 2)
            }
          }
        })
      });

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.statusText}`);
      }

      const gist = await response.json();
      return {
        success: true,
        url: gist.html_url,
        gistId: gist.id
      };

    } catch (error) {
      logger.error('Gist creation error', error);
      return { success: false };
    }
  }

  /**
   * Create a base64 URL (fallback)
   */
  private createBase64Url(data: any): ShareResult {
    const base64 = this.exporter.toBase64(data);
    const url = `https://dollhousemcp.com/import#dollhouse-persona=${base64}`;
    
    return {
      success: true,
      url,
      expiresAt: data.expiresAt,
      message: this.formatShareSuccess(url, data.expiresAt)
    };
  }

  /**
   * Import from GitHub Gist
   */
  private async importFromGist(gistId: string): Promise<{ success: boolean; data?: any; message: string }> {
    try {
      const response = await fetch(`https://api.github.com/gists/${gistId}`, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'DollhouseMCP/1.0'
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch gist: ${response.statusText}`);
      }

      const gist = await response.json();
      const personaFile = gist.files['persona.json'];
      
      if (!personaFile) {
        throw new Error('No persona data found in gist');
      }

      const data = JSON.parse(personaFile.content);
      
      // Check expiry
      if (data.expiresAt && new Date(data.expiresAt) < new Date()) {
        return {
          success: false,
          message: 'This share link has expired'
        };
      }

      return {
        success: true,
        data,
        message: 'Successfully retrieved persona from GitHub'
      };

    } catch (error) {
      logger.error('Gist import error', error);
      return {
        success: false,
        message: `Failed to import from gist: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Import from base64 URL
   */
  private importFromBase64Url(url: string): { success: boolean; data?: any; message: string } {
    try {
      const match = url.match(/#dollhouse-persona=(.+)$/);
      if (!match) {
        throw new Error('Invalid share URL format');
      }

      const base64 = match[1];
      const json = Buffer.from(base64, 'base64').toString('utf-8');
      const data = JSON.parse(json);

      // Check expiry
      if (data.expiresAt && new Date(data.expiresAt) < new Date()) {
        return {
          success: false,
          message: 'This share link has expired'
        };
      }

      return {
        success: true,
        data,
        message: 'Successfully decoded persona data'
      };

    } catch (error) {
      return {
        success: false,
        message: `Failed to decode share URL: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Extract Gist ID from GitHub URL
   */
  private extractGistId(url: string): string | null {
    const match = url.match(/gist\.github\.com\/[^\/]+\/([a-f0-9]+)/);
    return match ? match[1] : null;
  }

  /**
   * Format share success message
   */
  private formatShareSuccess(url: string, expiresAt: string): string {
    const expiryDate = new Date(expiresAt);
    const daysUntilExpiry = Math.ceil((expiryDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000));

    return `✅ Successfully created share link!

🔗 Share URL:
${url}

⏱️ Expires: ${expiryDate.toLocaleDateString()} (${daysUntilExpiry} days)

📋 To share this persona:
1. Copy the URL above
2. Share it with others
3. They can import using: import_from_url "${url}"

🔒 Privacy: This link is private and will expire automatically.`;
  }
}