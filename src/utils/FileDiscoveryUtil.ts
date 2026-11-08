/**
 * Utility class for efficient file discovery operations
 * Provides optimized file search with caching and security
 * 
 * IMPLEMENTATION (PR #503 - PR #496 Recommendation):
 * 1. PERFORMANCE: Single readdir operation instead of multiple file checks
 * 2. PERFORMANCE: 5-second cache TTL for repeated searches
 * 3. SECURITY: Unicode normalization for all search inputs
 * 4. MEMORY: Efficient cache management with 100 entry limit
 * 
 * This addresses the PR #496 review recommendation to extract file discovery
 * logic to a reusable utility class for better performance and maintainability.
 */

import * as path from 'node:path';
import { logger } from './logger.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { IFileOperationsService, FileOperationsService, isAbsentKindError } from '../services/FileOperationsService.js';
import { FileLockManager } from '../security/fileLockManager.js';

// Singleton file operations service for static methods
let fileOperationsService: IFileOperationsService | null = null;

function getFileOperationsService(): IFileOperationsService {
  fileOperationsService ??= new FileOperationsService(new FileLockManager());
  return fileOperationsService;
}

export interface FileSearchOptions {
  extensions?: string[];
  partialMatch?: boolean;
  maxResults?: number;
  cacheResults?: boolean;
}

interface CacheEntry {
  files: string[];
  timestamp: number;
}

export class FileDiscoveryUtil {
  private static readonly CACHE_TTL = 5000; // 5 seconds cache TTL
  private static readonly cache = new Map<string, CacheEntry>();
  
  /**
   * Find files in a directory with optimized search
   * Uses single readdir operation and filters results
   */
  static async findFiles(
    directory: string,
    searchName: string,
    options: FileSearchOptions = {}
  ): Promise<string[]> {
    const {
      extensions = ['.json', '.yaml', '.yml', '.md'],
      partialMatch = true,
      maxResults = 10,
      cacheResults = true
    } = options;
    
    // Normalize search name for security
    const normalizedSearch = UnicodeValidator.normalize(searchName);
    if (!normalizedSearch.isValid) {
      logger.warn('Invalid Unicode in search name', {
        issues: normalizedSearch.detectedIssues
      });
      return [];
    }
    const safeName = normalizedSearch.normalizedContent.toLowerCase();
    
    // Check cache if enabled
    const cacheKey = `${directory}:${safeName}:${JSON.stringify(options)}`;
    if (cacheResults) {
      const cached = this.getCached(cacheKey);
      if (cached) {
        logger.debug('File search cache hit', { directory, searchName });
        return cached;
      }
    }
    
    const files = await this.listDirectory(directory, searchName);
    // Single readdir operation for efficiency; patterns filter the listing.
    const matches = this.matchFiles(directory, files, this.buildSearchPatterns(safeName, extensions), partialMatch, maxResults);

    if (matches.length > 0) {
      if (cacheResults) this.setCached(cacheKey, matches);
      // Log file discovery for monitoring
      logger.debug('Files discovered', {
        directory,
        searchName,
        count: matches.length
      });
    }

    return matches;
  }

  /** One listing; a missing directory holds no matches, any other failure is reported, never read as "not found". */
  private static async listDirectory(directory: string, searchName: string): Promise<string[]> {
    try {
      return await getFileOperationsService().listDirectory(directory);
    } catch (error) {
      if (isAbsentKindError(error)) return [];
      logger.error('File discovery failed', {
        directory,
        searchName,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /** Each pattern a file matches adds it once, up to the result limit. */
  private static matchFiles(directory: string, files: readonly string[], patterns: readonly string[],
    partialMatch: boolean, maxResults: number): string[] {
    const matches: string[] = [];
    for (const file of files) {
      const fileLower = file.toLowerCase();
      for (const pattern of patterns) {
        if (matches.length >= maxResults) return matches;
        if (this.matchesPattern(fileLower, pattern, partialMatch)) matches.push(path.join(directory, file));
      }
      if (matches.length >= maxResults) return matches;
    }
    return matches;
  }
  
  /**
   * Build search patterns for different file extensions
   */
  private static buildSearchPatterns(baseName: string, extensions: string[]): string[] {
    const patterns: string[] = [baseName];
    
    // Add extension variations
    for (const ext of extensions) {
      patterns.push(`${baseName}${ext}`);
    }
    
    // Add common variations
    const nameWithoutExtension = baseName.replace(/\.[^.]+$/, '');
    if (nameWithoutExtension !== baseName) {
      patterns.push(nameWithoutExtension);
      for (const ext of extensions) {
        patterns.push(`${nameWithoutExtension}${ext}`);
      }
    }
    
    return patterns;
  }
  
  /**
   * Check if filename matches pattern
   */
  private static matchesPattern(filename: string, pattern: string, partialMatch: boolean): boolean {
    if (partialMatch) {
      return filename.includes(pattern);
    }
    return filename === pattern;
  }
  
  /**
   * Get cached results if still valid
   */
  private static getCached(key: string): string[] | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    const age = Date.now() - entry.timestamp;
    if (age > this.CACHE_TTL) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.files;
  }
  
  /**
   * Cache results with timestamp
   */
  private static setCached(key: string, files: string[]): void {
    // Limit cache size to prevent memory issues
    if (this.cache.size > 100) {
      // Remove oldest entries
      const entries = Array.from(this.cache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      for (let i = 0; i < 50; i++) {
        this.cache.delete(entries[i][0]);
      }
    }
    
    this.cache.set(key, {
      files,
      timestamp: Date.now()
    });
  }
  
  /**
   * Clear the cache
   */
  static clearCache(): void {
    this.cache.clear();
    logger.debug('File discovery cache cleared');
  }
  
  /**
   * Find a single file (convenience method)
   */
  static async findFile(
    directory: string,
    searchName: string,
    options?: FileSearchOptions
  ): Promise<string | null> {
    const files = await this.findFiles(directory, searchName, {
      ...options,
      maxResults: 1
    });
    return files.length > 0 ? files[0] : null;
  }
}