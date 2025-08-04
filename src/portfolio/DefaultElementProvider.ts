/**
 * DefaultElementProvider - Populates portfolio with default elements from bundled data
 * 
 * This class handles copying default personas, skills, templates, and other elements
 * from the NPM package or Git repository to the user's portfolio on first run.
 * It ensures users have example content to work with immediately after installation.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { ElementType } from './types.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

export class DefaultElementProvider {
  private readonly __dirname: string;
  
  constructor() {
    const __filename = fileURLToPath(import.meta.url);
    this.__dirname = path.dirname(__filename);
  }
  
  /**
   * Search paths for bundled data directory
   * Ordered by priority - development/git installations first, then NPM locations
   */
  private get dataSearchPaths(): string[] {
    return [
      // Development/Git installation (relative to this file)
      path.join(this.__dirname, '../../data'),
      path.join(this.__dirname, '../../../data'),
      
      // NPM installations - macOS Homebrew
      '/opt/homebrew/lib/node_modules/@dollhousemcp/mcp-server/data',
      
      // NPM installations - standard Unix/Linux
      '/usr/local/lib/node_modules/@dollhousemcp/mcp-server/data',
      '/usr/lib/node_modules/@dollhousemcp/mcp-server/data',
      
      // NPM installations - Windows
      'C:\\Program Files\\nodejs\\node_modules\\@dollhousemcp\\mcp-server\\data',
      'C:\\Program Files (x86)\\nodejs\\node_modules\\@dollhousemcp\\mcp-server\\data',
      
      // NPM installations - Windows with nvm
      path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@dollhousemcp', 'mcp-server', 'data'),
      
      // Current working directory (last resort)
      path.join(process.cwd(), 'data')
    ];
  }
  
  /**
   * Find the bundled data directory by checking each search path
   * Uses Promise.allSettled for better performance
   */
  private async findDataDirectory(): Promise<string | null> {
    // Check all paths in parallel for better performance
    const checkPromises = this.dataSearchPaths.map(async (searchPath) => {
      try {
        const stats = await fs.stat(searchPath);
        if (stats.isDirectory()) {
          return searchPath;
        }
      } catch (error) {
        // Directory doesn't exist
        return null;
      }
      return null;
    });
    
    const results = await Promise.allSettled(checkPromises);
    
    // Find the first successful result
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        logger.info(`[DefaultElementProvider] Found data directory at: ${result.value}`);
        return result.value;
      }
    }
    
    logger.warn('[DefaultElementProvider] No bundled data directory found in any search path');
    return null;
  }
  
  /**
   * Copy all files from source directory to destination directory
   * Skips files that already exist to preserve user modifications
   */
  private async copyElementFiles(sourceDir: string, destDir: string, elementType: string): Promise<number> {
    let copiedCount = 0;
    
    try {
      // Ensure destination directory exists
      await fs.mkdir(destDir, { recursive: true });
      
      // Read source directory
      const files = await fs.readdir(sourceDir);
      
      for (const file of files) {
        // Only copy .md files
        if (!file.endsWith('.md')) {
          continue;
        }
        
        // Normalize filename for security
        const normalizedFile = UnicodeValidator.normalize(file);
        if (!normalizedFile.isValid) {
          logger.warn(`[DefaultElementProvider] Skipping file with invalid Unicode: ${file}`);
          continue;
        }
        
        const sourcePath = path.join(sourceDir, normalizedFile.normalizedContent);
        const destPath = path.join(destDir, normalizedFile.normalizedContent);
        
        try {
          // Check if destination file already exists
          await fs.access(destPath);
          logger.debug(`[DefaultElementProvider] Skipping existing file: ${normalizedFile.normalizedContent}`);
          continue;
        } catch {
          // File doesn't exist, proceed with copy
        }
        
        try {
          // Copy the file
          await fs.copyFile(sourcePath, destPath);
          copiedCount++;
          logger.debug(`[DefaultElementProvider] Copied ${elementType}: ${normalizedFile.normalizedContent}`);
        } catch (error) {
          logger.error(`[DefaultElementProvider] Failed to copy ${normalizedFile.normalizedContent}:`, error);
        }
      }
      
      if (copiedCount > 0) {
        logger.info(`[DefaultElementProvider] Copied ${copiedCount} ${elementType} file(s)`);
      }
      
    } catch (error) {
      logger.error(`[DefaultElementProvider] Error copying ${elementType} files:`, error);
    }
    
    return copiedCount;
  }
  
  /**
   * Populate the portfolio with default elements from bundled data
   * This is called during portfolio initialization for new installations
   */
  public async populateDefaults(portfolioBaseDir: string): Promise<void> {
    logger.info('[DefaultElementProvider] Checking for default elements to populate...');
    
    // Find the bundled data directory
    const dataDir = await this.findDataDirectory();
    if (!dataDir) {
      logger.warn('[DefaultElementProvider] No bundled data found - portfolio will start empty');
      return;
    }
    
    // Track total files copied
    let totalCopied = 0;
    
    // Map of data subdirectory names (plural) to portfolio directory names (singular)
    const elementMappings: Record<string, ElementType> = {
      'personas': ElementType.PERSONA,
      'skills': ElementType.SKILL,
      'templates': ElementType.TEMPLATE,
      'agents': ElementType.AGENT,
      'memories': ElementType.MEMORY,
      'ensembles': ElementType.ENSEMBLE
    };
    
    // Copy each element type
    for (const [dataSubdir, elementType] of Object.entries(elementMappings)) {
      const sourceDir = path.join(dataDir, dataSubdir);
      const destDir = path.join(portfolioBaseDir, elementType);
      
      try {
        // Check if source directory exists
        await fs.access(sourceDir);
        const copiedCount = await this.copyElementFiles(sourceDir, destDir, dataSubdir);
        totalCopied += copiedCount;
      } catch (error) {
        // Source directory doesn't exist, skip
        logger.debug(`[DefaultElementProvider] No ${dataSubdir} directory in bundled data`);
      }
    }
    
    if (totalCopied > 0) {
      logger.info(`[DefaultElementProvider] Successfully populated portfolio with ${totalCopied} default element(s)`);
    } else {
      logger.info('[DefaultElementProvider] No new elements to copy - portfolio may already have content');
    }
  }
}