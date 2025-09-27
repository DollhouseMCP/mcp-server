/**
 * PortfolioDownloader - Downloads elements from GitHub repositories
 * 
 * Handles fetching file contents from GitHub, decoding base64 content,
 * and returning structured element data ready for local storage.
 */

import { PortfolioRepoManager } from '../portfolio/PortfolioRepoManager.js';
import { logger } from '../utils/logger.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

export interface ElementData {
  content: string;
  metadata: Record<string, any>;
  sha: string;
}

export class PortfolioDownloader {
  /**
   * Download an element from GitHub
   */
  async downloadFromGitHub(
    repoManager: PortfolioRepoManager,
    elementPath: string,
    username: string,
    repository: string
  ): Promise<ElementData> {
    try {
      logger.info('Downloading element from GitHub', { 
        path: elementPath, 
        username, 
        repository 
      });

      // Fetch the file content from GitHub
      const response = await repoManager.githubRequest(
        `/repos/${username}/${repository}/contents/${elementPath}`
      );

      if (!response || !response.content) {
        throw new Error(`No content found at path: ${elementPath}`);
      }

      // Decode base64 content
      const decodedContent = Buffer.from(response.content, 'base64').toString('utf-8');
      
      // Normalize Unicode for security
      const normalized = UnicodeValidator.normalize(decodedContent);
      
      // Log download for audit trail
      logger.info('Element downloaded successfully', {
        path: elementPath,
        repository: `${username}/${repository}`,
        sha: response.sha
      });

      // Parse metadata from frontmatter if present
      const metadata = this.extractMetadata(normalized.normalizedContent);

      return {
        content: normalized.normalizedContent,
        metadata,
        sha: response.sha
      };
      
    } catch (error) {
      logger.error('Failed to download element from GitHub', { 
        error, 
        path: elementPath 
      });
      
      // Re-throw with more context
      if (error instanceof Error) {
        if (error.message.includes('404')) {
          throw new Error(`Element not found at path: ${elementPath}`);
        }
        if (error.message.includes('401') || error.message.includes('403')) {
          throw new Error(`Authentication failed. Please check your GitHub token.`);
        }
        throw error;
      }
      
      throw new Error(`Failed to download ${elementPath}: ${String(error)}`);
    }
  }

  /**
   * Extract metadata from frontmatter
   */
  private extractMetadata(content: string): Record<string, any> {
    const metadata: Record<string, any> = {};
    
    // Check for YAML frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    
    if (frontmatterMatch) {
      try {
        // Parse the frontmatter as simple key-value pairs
        // (avoiding using yaml.load for security)
        const frontmatterContent = frontmatterMatch[1];
        const lines = frontmatterContent.split('\n');
        
        for (const line of lines) {
          const colonIndex = line.indexOf(':');
          if (colonIndex > 0) {
            const key = line.substring(0, colonIndex).trim();
            const value = line.substring(colonIndex + 1).trim();
            
            // Remove quotes if present
            const cleanValue = value.replace(/(^["'])|(['"]$)/g, '');
            
            // Try to parse as JSON for arrays/objects, otherwise use as string
            try {
              metadata[key] = JSON.parse(cleanValue);
            } catch {
              metadata[key] = cleanValue;
            }
          }
        }
      } catch (error) {
        logger.warn('Failed to parse frontmatter metadata', { error });
      }
    }
    
    return metadata;
  }

  /**
   * Download multiple elements in batch
   */
  async downloadBatch(
    repoManager: PortfolioRepoManager,
    elementPaths: string[],
    username: string,
    repository: string,
    onProgress?: (downloaded: number, total: number) => void
  ): Promise<Map<string, ElementData>> {
    const results = new Map<string, ElementData>();
    let downloaded = 0;
    
    for (const path of elementPaths) {
      try {
        const elementData = await this.downloadFromGitHub(
          repoManager,
          path,
          username,
          repository
        );
        
        results.set(path, elementData);
        downloaded++;
        
        if (onProgress) {
          onProgress(downloaded, elementPaths.length);
        }
      } catch (error) {
        logger.error(`Failed to download ${path}`, { error });
        // Continue with other downloads even if one fails
      }
    }
    
    return results;
  }
}