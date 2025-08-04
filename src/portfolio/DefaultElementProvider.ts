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
import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import { ElementType } from './types.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

// File operation constants
export const FILE_CONSTANTS = {
  ELEMENT_EXTENSION: '.md',
  YAML_EXTENSION: '.yaml',
  YML_EXTENSION: '.yml',
  JSON_EXTENSION: '.json',
  MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB max file size for safety
  CHECKSUM_ALGORITHM: 'sha256',
  FILE_PERMISSIONS: 0o644,
  CHUNK_SIZE: 64 * 1024 // 64KB chunks for reading large files
} as const;

// Internal constants
const DATA_DIR_CACHE_KEY = 'dollhouse_data_dir';
const COPY_RETRY_ATTEMPTS = 3;
const COPY_RETRY_DELAY = 100; // ms

export interface DefaultElementProviderConfig {
  /** Custom data directory paths to search (checked before default paths) */
  customDataPaths?: string[];
  /** Whether to use default search paths after custom paths */
  useDefaultPaths?: boolean;
}

export class DefaultElementProvider {
  private readonly __dirname: string;
  private static cachedDataDir: string | null = null;
  private static populateInProgress: Map<string, Promise<void>> = new Map();
  private readonly config: DefaultElementProviderConfig;
  
  constructor(config?: DefaultElementProviderConfig) {
    const __filename = fileURLToPath(import.meta.url);
    this.__dirname = path.dirname(__filename);
    this.config = {
      useDefaultPaths: true,
      ...config
    };
  }
  
  /**
   * Search paths for bundled data directory
   * Ordered by priority - custom paths first, then development/git, then NPM locations
   */
  private get dataSearchPaths(): string[] {
    const paths: string[] = [];
    
    // Add custom paths first (highest priority)
    if (this.config.customDataPaths) {
      paths.push(...this.config.customDataPaths);
    }
    
    // Add default paths if enabled
    if (this.config.useDefaultPaths !== false) {
      paths.push(
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
      );
    }
    
    return paths;
  }
  
  /**
   * Find the bundled data directory by checking each search path
   * Uses Promise.allSettled for better performance and caches the result
   */
  private async findDataDirectory(): Promise<string | null> {
    // Return cached value if available
    if (DefaultElementProvider.cachedDataDir !== null) {
      return DefaultElementProvider.cachedDataDir;
    }
    
    // Check all paths in parallel for better performance
    const checkPromises = this.dataSearchPaths.map(async (searchPath) => {
      try {
        const stats = await fs.stat(searchPath);
        if (stats.isDirectory()) {
          // Verify it contains expected subdirectories
          const hasPersonas = await this.directoryExists(path.join(searchPath, 'personas'));
          const hasSkills = await this.directoryExists(path.join(searchPath, 'skills'));
          if (hasPersonas || hasSkills) {
            return searchPath;
          }
        }
      } catch (error) {
        // Directory doesn't exist or can't be accessed
        return null;
      }
      return null;
    });
    
    const results = await Promise.allSettled(checkPromises);
    
    // Find the first successful result
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        logger.info(`[DefaultElementProvider] Found data directory at: ${result.value}`);
        // Cache the result
        DefaultElementProvider.cachedDataDir = result.value;
        return result.value;
      }
    }
    
    logger.warn('[DefaultElementProvider] No bundled data directory found in any search path');
    return null;
  }
  
  /**
   * Helper to check if a directory exists
   */
  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(dirPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
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
        // Only copy markdown files
        if (!file.endsWith(FILE_CONSTANTS.ELEMENT_EXTENSION)) {
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
          // Validate source file before copying
          const sourceStats = await fs.stat(sourcePath);
          
          // Check file size limit
          if (sourceStats.size > FILE_CONSTANTS.MAX_FILE_SIZE) {
            logger.warn(
              `[DefaultElementProvider] Skipping oversized file ${normalizedFile.normalizedContent}: ` +
              `${sourceStats.size} bytes (max: ${FILE_CONSTANTS.MAX_FILE_SIZE} bytes)`,
              { 
                file: normalizedFile.normalizedContent, 
                size: sourceStats.size,
                maxSize: FILE_CONSTANTS.MAX_FILE_SIZE,
                elementType 
              }
            );
            continue;
          }
          
          // Copy the file with verification
          await this.copyFileWithVerification(sourcePath, destPath);
          copiedCount++;
          logger.debug(`[DefaultElementProvider] Copied ${elementType}: ${normalizedFile.normalizedContent}`);
        } catch (error) {
          const err = error as Error;
          logger.error(
            `[DefaultElementProvider] Failed to copy ${normalizedFile.normalizedContent}`,
            { 
              error: err.message,
              stack: err.stack,
              sourcePath,
              destPath,
              elementType
            }
          );
          // Continue with other files instead of failing completely
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
   * Copy a file with integrity verification
   * Ensures the file was copied correctly by comparing sizes
   */
  /**
   * Calculate checksum of a file for integrity verification
   * @param filePath Path to the file
   * @returns Hex-encoded checksum
   */
  private async calculateChecksum(filePath: string): Promise<string> {
    const hash = createHash(FILE_CONSTANTS.CHECKSUM_ALGORITHM);
    const stream = await fs.open(filePath, 'r');
    
    try {
      const buffer = Buffer.alloc(FILE_CONSTANTS.CHUNK_SIZE);
      let bytesRead: number;
      
      do {
        const result = await stream.read(buffer, 0, FILE_CONSTANTS.CHUNK_SIZE);
        bytesRead = result.bytesRead;
        
        if (bytesRead > 0) {
          hash.update(buffer.subarray(0, bytesRead));
        }
      } while (bytesRead > 0);
      
      return hash.digest('hex');
    } finally {
      await stream.close();
    }
  }

  /**
   * Copy file with integrity verification and retry logic
   * @param sourcePath Source file path
   * @param destPath Destination file path
   * @throws Error if copy fails after all retry attempts
   */
  private async copyFileWithVerification(sourcePath: string, destPath: string): Promise<void> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= COPY_RETRY_ATTEMPTS; attempt++) {
      try {
        // Copy the file
        await fs.copyFile(sourcePath, destPath);
        
        // Verify size matches
        const [sourceStats, destStats] = await Promise.all([
          fs.stat(sourcePath),
          fs.stat(destPath)
        ]);
        
        if (sourceStats.size !== destStats.size) {
          throw new Error(
            `Size mismatch after copy - source: ${sourceStats.size} bytes, ` +
            `destination: ${destStats.size} bytes`
          );
        }
        
        // Verify checksum matches for complete integrity
        const [sourceChecksum, destChecksum] = await Promise.all([
          this.calculateChecksum(sourcePath),
          this.calculateChecksum(destPath)
        ]);
        
        if (sourceChecksum !== destChecksum) {
          throw new Error(
            `Checksum mismatch after copy - source: ${sourceChecksum}, ` +
            `destination: ${destChecksum}`
          );
        }
        
        // Set proper permissions
        try {
          await fs.chmod(destPath, FILE_CONSTANTS.FILE_PERMISSIONS);
        } catch (error) {
          logger.debug(
            `[DefaultElementProvider] Could not set permissions on ${destPath}: ${error}`,
            { sourcePath, destPath, attempt }
          );
        }
        
        // Success - file copied and verified
        logger.debug(
          `[DefaultElementProvider] Successfully copied and verified: ${path.basename(sourcePath)}`,
          { size: sourceStats.size, checksum: sourceChecksum.substring(0, 8) }
        );
        return;
        
      } catch (error) {
        lastError = error as Error;
        
        // Clean up failed copy
        try {
          await fs.unlink(destPath);
        } catch {
          // Ignore cleanup errors
        }
        
        if (attempt < COPY_RETRY_ATTEMPTS) {
          logger.debug(
            `[DefaultElementProvider] Copy attempt ${attempt} failed, retrying...`,
            { error: lastError.message, sourcePath, destPath }
          );
          await new Promise(resolve => setTimeout(resolve, COPY_RETRY_DELAY * attempt));
        }
      }
    }
    
    // All attempts failed
    throw new Error(
      `Failed to copy ${path.basename(sourcePath)} after ${COPY_RETRY_ATTEMPTS} attempts: ` +
      `${lastError?.message || 'Unknown error'}`
    );
  }
  
  /**
   * Populate the portfolio with default elements from bundled data
   * This is called during portfolio initialization for new installations
   * Protected against concurrent calls to prevent race conditions
   */
  public async populateDefaults(portfolioBaseDir: string): Promise<void> {
    // Check if population is already in progress for this portfolio
    const existingPopulation = DefaultElementProvider.populateInProgress.get(portfolioBaseDir);
    if (existingPopulation) {
      logger.debug(
        '[DefaultElementProvider] Population already in progress for portfolio, waiting...',
        { portfolioBaseDir }
      );
      return existingPopulation;
    }
    
    // Create new population promise
    const populationPromise = this.performPopulation(portfolioBaseDir)
      .finally(() => {
        // Clean up when done
        DefaultElementProvider.populateInProgress.delete(portfolioBaseDir);
      });
    
    DefaultElementProvider.populateInProgress.set(portfolioBaseDir, populationPromise);
    return populationPromise;
  }
  
  /**
   * Perform the actual population of default elements
   * @param portfolioBaseDir Base directory of the portfolio
   */
  private async performPopulation(portfolioBaseDir: string): Promise<void> {
    logger.info(
      '[DefaultElementProvider] Starting default element population',
      { portfolioBaseDir }
    );
    
    // Find the bundled data directory
    const dataDir = await this.findDataDirectory();
    if (!dataDir) {
      logger.warn(
        '[DefaultElementProvider] No bundled data directory found - portfolio will start empty',
        { 
          searchPaths: this.dataSearchPaths.slice(0, 3), // Log first few paths for debugging
          cwd: process.cwd(),
          dirname: this.__dirname
        }
      );
      return;
    }
    
    // Track total files copied
    let totalCopied = 0;
    const copiedCounts: Record<string, number> = {};
    
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
        copiedCounts[dataSubdir] = copiedCount;
        totalCopied += copiedCount;
      } catch (error) {
        // Source directory doesn't exist, skip
        logger.debug(`[DefaultElementProvider] No ${dataSubdir} directory in bundled data`);
      }
    }
    
    if (totalCopied > 0) {
      logger.info(
        `[DefaultElementProvider] Successfully populated portfolio with ${totalCopied} default element(s)`,
        {
          portfolioBaseDir,
          dataDir,
          breakdown: Object.entries(elementMappings).reduce((acc, [dataDir, elementType]) => {
            acc[elementType] = copiedCounts[dataDir] || 0;
            return acc;
          }, {} as Record<string, number>)
        }
      );
    } else {
      logger.info('[DefaultElementProvider] No new elements to copy - portfolio may already have content');
    }
  }
}