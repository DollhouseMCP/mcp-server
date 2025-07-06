/**
 * Check for updates from GitHub releases
 */

import { RELEASES_API_URL } from '../config/constants.js';
import { VersionManager } from './VersionManager.js';
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  isUpdateAvailable: boolean;
  releaseDate: string;
  releaseNotes: string;
  releaseUrl: string;
}

export class UpdateChecker {
  private versionManager: VersionManager;
  
  constructor(versionManager: VersionManager) {
    if (!versionManager) {
      throw new Error('VersionManager is required');
    }
    this.versionManager = versionManager;
  }
  
  /**
   * Execute a network operation with retry logic and exponential backoff
   */
  private async retryNetworkOperation<T>(
    operation: () => Promise<T>, 
    maxRetries: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    let lastError: Error;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        
        // Don't retry on the last attempt
        if (attempt === maxRetries) {
          break;
        }
        
        // Don't retry certain errors (like 404, 401)
        if (error instanceof Error && error.message.includes('404')) {
          break;
        }
        
        // Calculate delay with exponential backoff
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw lastError!;
  }
  
  /**
   * Check for updates from GitHub releases
   */
  async checkForUpdates(): Promise<UpdateCheckResult | null> {
    const currentVersion = await this.versionManager.getCurrentVersion();
    
    // Check GitHub releases API for latest version with retry logic
    const response = await this.retryNetworkOperation(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      try {
        const response = await fetch(RELEASES_API_URL, {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'DollhouseMCP/1.0'
          },
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    });
    
    if (!response.ok) {
      if (response.status === 404) {
        return null; // No releases found
      }
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }
    
    const releaseData = await response.json();
    const latestVersion = releaseData.tag_name?.replace(/^v/, '') || releaseData.name;
    const publishedAt = new Date(releaseData.published_at).toLocaleDateString();
    
    // Compare versions
    const isUpdateAvailable = this.versionManager.compareVersions(currentVersion, latestVersion) < 0;
    
    const releaseNotes = releaseData.body || 'See release notes on GitHub';
    
    return {
      currentVersion,
      latestVersion,
      isUpdateAvailable,
      releaseDate: publishedAt,
      releaseNotes,
      releaseUrl: releaseData.html_url
    };
  }
  
  /**
   * Format update check results for display
   */
  formatUpdateCheckResult(result: UpdateCheckResult | null, error?: Error, personaIndicator: string = ''): string {
    if (error) {
      const isAbortError = error.name === 'AbortError';
      
      return personaIndicator + 
        '❌ **Update Check Failed**\n\n' +
        'Error: ' + error.message + '\n\n' +
        (isAbortError 
          ? 'The request timed out. Please check your internet connection and try again.'
          : 'Tips:\n' +
            '• Check your internet connection\n' +
            '• Ensure GitHub.com is accessible\n' +
            '• Try running `update_server true` for manual update\n' +
            '• Visit https://github.com/mickdarling/DollhouseMCP/releases');
    }
    
    if (!result) {
      const currentVersion = 'unknown';
      return personaIndicator + 
        '📦 **Update Check Complete**\n\n' +
        '🔄 **Current Version:** ' + currentVersion + '\n' +
        '📡 **Remote Status:** No releases found on GitHub\n' +
        'ℹ️ **Note:** This may be a development version or releases haven\'t been published yet.\n\n' +
        '**Manual Update:**\n' +
        'Use `update_server true` to pull latest changes from main branch.';
    }
    
    const statusParts = [
      personaIndicator + '📦 **Update Check Complete**\n\n',
      '🔄 **Current Version:** ' + result.currentVersion + '\n',
      '📡 **Latest Version:** ' + result.latestVersion + '\n',
      '📅 **Released:** ' + this.formatDate(result.releaseDate) + '\n\n'
    ];
    
    if (result.isUpdateAvailable) {
      statusParts.push(
        '✨ **Update Available!**\n\n',
        '**What\'s New:**\n' + this.sanitizeReleaseNotes(result.releaseNotes) + '\n\n',
        '**To Update:**\n',
        '• Use: `update_server true`\n',
        '• Or visit: ' + this.sanitizeUrl(result.releaseUrl) + '\n\n',
        '⚠️ **Note:** Update will restart the server and reload all personas.'
      );
    } else {
      statusParts.push(
        '✅ **You\'re Up to Date!**\n\n',
        'Your DollhouseMCP installation is current.\n',
        'Check back later for new features and improvements.'
      );
    }
    
    return statusParts.join('');
  }
  
  /**
   * Sanitize URLs to prevent dangerous schemes
   */
  private sanitizeUrl(url: string): string {
    if (!url) return '';
    
    // Only allow http and https schemes
    const allowedSchemes = ['http:', 'https:'];
    try {
      const parsed = new URL(url);
      if (!allowedSchemes.includes(parsed.protocol)) {
        return '';  // Return empty string for dangerous schemes
      }
      return url;
    } catch {
      return '';  // Invalid URL
    }
  }
  
  /**
   * Sanitize release notes to prevent XSS and limit length
   */
  private sanitizeReleaseNotes(notes: string): string {
    if (!notes) return 'See release notes on GitHub';
    
    // Apply length limit (5000 chars)
    let sanitized = notes;
    if (sanitized.length > 5000) {
      sanitized = sanitized.substring(0, 5000) + '...';
    }
    
    // Sanitize HTML/JavaScript
    const window = new JSDOM('').window;
    const purify = DOMPurify(window);
    sanitized = purify.sanitize(sanitized, { 
      ALLOWED_TAGS: [],  // Strip all HTML tags
      ALLOWED_ATTR: [] 
    });
    
    // Additional sanitization for command injection patterns
    sanitized = sanitized
      .replace(/`[^`]*`/g, '')  // Remove backtick expressions
      .replace(/\$\([^)]*\)/g, '')  // Remove command substitution
      .replace(/\$\{[^}]*\}/g, '');  // Remove variable expansion
    
    return sanitized;
  }
  
  /**
   * Format date to human-readable format
   */
  private formatDate(dateStr: string): string {
    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) {
        return dateStr;  // Return original if invalid
      }
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
    } catch {
      return dateStr;  // Return original on error
    }
  }
}