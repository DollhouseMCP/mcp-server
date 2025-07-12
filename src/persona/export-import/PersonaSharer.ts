/**
 * Persona sharing functionality via URLs
 */

import { Persona } from '../../types/persona.js';
import { PersonaExporter, ExportedPersona } from './PersonaExporter.js';
import { GitHubClient } from '../../marketplace/GitHubClient.js';
import { TokenManager } from '../../security/tokenManager.js';
import { SecurityError } from '../../security/errors.js';
import { logger } from '../../utils/logger.js';
import { RateLimiter } from '../../update/RateLimiter.js';

export interface ShareResult {
  success: boolean;
  url?: string;
  gistId?: string;
  expiresAt?: string;
  message: string;
}

export class PersonaSharer {
  private exporter: PersonaExporter;
  private githubRateLimiter: RateLimiter;
  
  constructor(
    private githubClient: GitHubClient,
    private currentUser: string | null
  ) {
    this.exporter = new PersonaExporter(currentUser);
    
    // GitHub API rate limit: 60 requests per hour for unauthenticated
    // 5000 per hour for authenticated - use TokenManager to check
    const hasValidToken = TokenManager.getGitHubToken() !== null;
    this.githubRateLimiter = new RateLimiter({
      maxRequests: hasValidToken ? 100 : 30, // Conservative limits
      windowMs: 60 * 60 * 1000, // 1 hour
      minDelayMs: 1000 // Minimum 1 second between requests
    });
  }

  /**
   * Share a persona via GitHub Gist
   */
  async sharePersona(persona: Persona, expiryDays: number = 7): Promise<ShareResult> {
    try {
      // Validate gist permissions if token is available
      const token = TokenManager.getGitHubToken();
      let hasValidToken = false;
      
      if (token) {
        try {
          const validation = await TokenManager.ensureTokenPermissions('gist');
          if (!validation.isValid) {
            const safeMessage = TokenManager.createSafeErrorMessage(validation.error || 'Unknown validation error', token);
            logger.warn('GitHub token lacks gist permissions, falling back to base64 URL', { error: safeMessage });
            // Continue to fallback instead of failing
          } else {
            hasValidToken = true;
          }
        } catch (error) {
          // Handle rate limiting or other security errors gracefully
          if (error instanceof SecurityError && error.code === 'RATE_LIMIT_EXCEEDED') {
            logger.warn('Token validation rate limited, falling back to base64 URL', { 
              error: 'Rate limit exceeded for token validation' 
            });
          } else if (error instanceof Error) {
            const safeMessage = TokenManager.createSafeErrorMessage(error.message, token);
            logger.warn('Token validation failed, falling back to base64 URL', { error: safeMessage });
          }
          // Continue to fallback instead of failing
        }
      }

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

      // Create GitHub Gist if token has proper permissions
      if (hasValidToken) {
        const gistResult = await this.createGist(persona.metadata.name, shareData);
        
        if (gistResult.success) {
          return {
            success: true,
            url: gistResult.url!,
            gistId: gistResult.gistId,
            expiresAt: shareData.expiresAt,
            message: this.formatShareSuccess(gistResult.url!, shareData.expiresAt)
          };
        }
      }

      // Fallback to base64 URL if Gist fails or no token
      return this.createBase64Url(shareData);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const safeMessage = TokenManager.createSafeErrorMessage(errorMessage);
      logger.error('Share error', { error: safeMessage });
      
      return {
        success: false,
        message: `Failed to share persona: ${safeMessage}`
      };
    }
  }

  /**
   * Import a persona from a share URL
   */
  async importFromUrl(url: string): Promise<{ success: boolean; data?: any; message: string }> {
    try {
      // Validate URL first
      if (!this.validateShareUrl(url)) {
        return {
          success: false,
          message: 'Invalid or unsafe URL provided'
        };
      }
      // Check if it's a GitHub Gist URL
      const gistId = this.extractGistId(url);
      if (gistId) {
        return await this.importFromGist(gistId);
      }

      // Check if it's a base64 URL
      if (url.includes('#dollhouse-persona=')) {
        return this.importFromBase64Url(url);
      }

      // Validate URL for security
      if (!this.validateShareUrl(url)) {
        throw new Error('Invalid or potentially malicious URL');
      }

      // Try direct fetch with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
      
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'DollhouseMCP/1.0',
            'Accept': 'application/json'
          }
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          throw new Error(`Failed to fetch: ${response.statusText}`);
        }

        const data = await response.json();
        return {
          success: true,
          data,
          message: 'Successfully retrieved persona data'
        };
      } finally {
        clearTimeout(timeoutId);
      }

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
      // Use TokenManager for secure token handling
      const token = TokenManager.getGitHubToken();
      if (!token) {
        logger.info('No valid GitHub token available for Gist creation');
        return { success: false };
      }
      
      // Check rate limit
      const rateLimitStatus = this.githubRateLimiter.checkLimit();
      if (!rateLimitStatus.allowed) {
        logger.warn(`GitHub API rate limit exceeded. Retry after ${rateLimitStatus.retryAfterMs}ms`);
        return { success: false };
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      try {
        const response = await fetch('https://api.github.com/gists', {
          method: 'POST',
          signal: controller.signal,
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
        
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorMsg = `GitHub API error: ${response.status} ${response.statusText}`;
          throw new Error(errorMsg);
        }

        const gist = await response.json();
        
        // Consume the rate limit token after successful request
        this.githubRateLimiter.consumeToken();
        
        return {
          success: true,
          url: gist.html_url,
          gistId: gist.id
        };
      } finally {
        clearTimeout(timeoutId);
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const safeMessage = TokenManager.createSafeErrorMessage(errorMessage);
      logger.error('Gist creation error', { error: safeMessage });
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
      // Check rate limit
      const rateLimitStatus = this.githubRateLimiter.checkLimit();
      if (!rateLimitStatus.allowed) {
        throw new Error(`GitHub API rate limit exceeded. Please try again in ${Math.ceil(rateLimitStatus.retryAfterMs! / 1000)} seconds`);
      }
      
      const gistUrl = `https://api.github.com/gists/${gistId}`;
      
      // Validate URL (should always pass for GitHub API)
      if (!this.validateShareUrl(gistUrl)) {
        throw new Error('Invalid GitHub API URL');
      }
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout for API
      
      try {
        const response = await fetch(gistUrl, {
          signal: controller.signal,
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'DollhouseMCP/1.0'
          }
        });
        
        clearTimeout(timeoutId);

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

        // Consume the rate limit token after successful request
        this.githubRateLimiter.consumeToken();
        
        return {
          success: true,
          data,
          message: 'Successfully retrieved persona from GitHub'
        };
      } finally {
        clearTimeout(timeoutId);
      }

    } catch (error) {
      logger.error('Gist import error', error);
      return {
        success: false,
        message: `Failed to import from gist: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Validate URL for security (prevent SSRF attacks)
   */
  private validateShareUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      
      // Only allow http/https protocols
      if (!['https:', 'http:'].includes(parsed.protocol)) {
        return false;
      }
      
      // Prevent SSRF attacks - block local/private networks
      const hostname = parsed.hostname.toLowerCase();
      if (hostname === 'localhost' || 
          hostname.startsWith('127.') ||
          hostname.startsWith('10.') ||
          hostname.startsWith('192.168.') ||
          hostname.startsWith('172.') ||
          hostname.startsWith('169.254.') ||
          hostname === '0.0.0.0' ||
          hostname.includes(':')) { // IPv6 localhost
        return false;
      }
      
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Import from base64 URL
   */
  private importFromBase64Url(url: string): { success: boolean; data?: any; message: string } {
    try {
      const match = url.match(/#dollhouse-persona=([A-Za-z0-9+/=]+)$/);
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