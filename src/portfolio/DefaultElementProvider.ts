/**
 * DefaultElementProvider - Populates portfolio with default elements from bundled data
 * 
 * This class handles copying default personas, skills, templates, and other elements
 * from the NPM package or Git repository to the user's portfolio on first run.
 * It ensures users have example content to work with immediately after installation.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import * as yaml from 'js-yaml';
import { logger } from '../utils/logger.js';
import { ElementType } from './types.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';

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

// Development mode detection
// When running from a git clone, we don't want to auto-load test data
const IS_DEVELOPMENT_MODE = (() => {
  try {
    // Check if we're in a git repository (development mode)
    const gitDir = path.join(process.cwd(), '.git');
    return fsSync.existsSync(gitDir);
  } catch {
    return false;
  }
})();

// Internal constants
const DATA_DIR_CACHE_KEY = 'dollhouse_data_dir';
const COPY_RETRY_ATTEMPTS = 3;
const COPY_RETRY_DELAY = 100; // ms

export interface DefaultElementProviderConfig {
  /** Custom data directory paths to search (checked before default paths) */
  customDataPaths?: string[];
  /** Whether to use default search paths after custom paths */
  useDefaultPaths?: boolean;
  /** Whether to load test/example data from repository (default: false in dev mode) */
  loadTestData?: boolean;
}

// PERFORMANCE: Metadata cache with mtime-based invalidation
interface MetadataCacheEntry {
  metadata: any;
  mtime: number;
  size: number;
}

export class DefaultElementProvider {
  private readonly __dirname: string;
  private static cachedDataDir: string | null = null;
  private static populateInProgress: Map<string, Promise<void>> = new Map();
  private readonly config: DefaultElementProviderConfig;
  
  // PERFORMANCE OPTIMIZATION: Cache metadata with file mtime for invalidation
  private static metadataCache: Map<string, MetadataCacheEntry> = new Map();
  private static readonly MAX_CACHE_SIZE = 20; // MEMORY LEAK FIX: Further reduced cache size to prevent accumulation during performance tests
  
  constructor(config?: DefaultElementProviderConfig) {
    const __filename = fileURLToPath(import.meta.url);
    this.__dirname = path.dirname(__filename);
    
    // Check environment variable for test data loading
    const envLoadTestData = process.env.DOLLHOUSE_LOAD_TEST_DATA;
    const loadTestDataFromEnv = envLoadTestData === 'true' || envLoadTestData === '1';
    const disableTestDataFromEnv = envLoadTestData === 'false' || envLoadTestData === '0';
    
    // Check if we're in development mode (with respect to FORCE_PRODUCTION_MODE override)
    const isDevMode = (() => {
      // Respect FORCE_PRODUCTION_MODE override first
      if (process.env.FORCE_PRODUCTION_MODE === 'true') {
        return false; // Force production mode
      }
      if (process.env.FORCE_PRODUCTION_MODE === 'false') {
        return true; // Force development mode
      }
      // Fall back to git detection
      return IS_DEVELOPMENT_MODE;
    })();
    
    // Determine loadTestData value
    let computedLoadTestData: boolean;
    if (loadTestDataFromEnv) {
      // Environment explicitly enables test data
      computedLoadTestData = true;
    } else if (disableTestDataFromEnv) {
      // Environment explicitly disables test data
      computedLoadTestData = false;
    } else {
      // Default logic: enable in production, disable in development unless config overrides
      computedLoadTestData = !isDevMode && (config?.loadTestData ?? true);
    }
    
    this.config = {
      useDefaultPaths: true,
      ...config,
      // Apply final loadTestData logic - environment variables and development mode take precedence
      loadTestData: loadTestDataFromEnv ? true : disableTestDataFromEnv ? false : computedLoadTestData
    };
    
    if (isDevMode && !this.config.loadTestData) {
      logger.info('[DefaultElementProvider] Development mode detected - test data loading disabled');
      logger.info('[DefaultElementProvider] To enable test data, set DOLLHOUSE_LOAD_TEST_DATA=true');
    }
  }
  
  /**
   * Get the current loadTestData configuration value
   * @returns Whether test data loading is enabled
   */
  public get isTestDataLoadingEnabled(): boolean {
    return this.config.loadTestData ?? false;
  }
  
  /**
   * Get whether the system is in development mode
   * @returns Whether running in development mode
   */
  public get isDevelopmentMode(): boolean {
    return IS_DEVELOPMENT_MODE;
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
      // Skip development/repository data paths unless test data loading is enabled
      if (this.config.loadTestData) {
        // Development/Git installation (relative to this file)
        paths.push(
          path.join(this.__dirname, '../../data'),
          path.join(this.__dirname, '../../../data'),
          // Current working directory (last resort)
          path.join(process.cwd(), 'data')
        );
      }
      
      // Always include NPM installation paths (these would have production data)
      paths.push(
        // NPM installations - macOS Homebrew
        '/opt/homebrew/lib/node_modules/@dollhousemcp/mcp-server/data',
        
        // NPM installations - standard Unix/Linux
        '/usr/local/lib/node_modules/@dollhousemcp/mcp-server/data',
        '/usr/lib/node_modules/@dollhousemcp/mcp-server/data',
        
        // NPM installations - Windows
        'C:\\Program Files\\nodejs\\node_modules\\@dollhousemcp\\mcp-server\\data',
        'C:\\Program Files (x86)\\nodejs\\node_modules\\@dollhousemcp\\mcp-server\\data',
        
        // NPM installations - Windows with nvm
        path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@dollhousemcp', 'mcp-server', 'data')
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
   * Validate file path to prevent path traversal attacks
   * SECURITY FIX: Added file path validation to prevent directory traversal
   * Previously: File paths were used without validation, allowing potential ../../../ attacks
   * Now: Strict validation ensures paths stay within allowed directories
   * @param filePath The file path to validate
   * @param allowedBasePaths Array of allowed base paths (optional)
   * @returns true if path is safe, false otherwise
   */
  private validateFilePath(filePath: string, allowedBasePaths?: string[]): boolean {
    try {
      // SECURITY: Normalize path to prevent traversal attempts
      const normalizedPath = path.normalize(filePath);
      
      // SECURITY: Reject paths containing traversal patterns
      if (normalizedPath.includes('..')) {
        logger.warn(`[DefaultElementProvider] Path traversal attempt blocked: ${filePath}`);
        return false;
      }
      
      // SECURITY: Check for home directory expansion attempts, but allow Windows 8.3 short path names
      // Windows short path names use ~ followed by a digit (e.g., RUNNER~1), which should be allowed
      // Only block ~ followed by / or \ (home directory expansion patterns)
      if (normalizedPath.includes('~/') || normalizedPath.includes('~\\')) {
        logger.warn(`[DefaultElementProvider] Home directory expansion attempt blocked: ${filePath}`);
        return false;
      }
      
      // SECURITY: Reject absolute paths outside allowed directories
      if (path.isAbsolute(normalizedPath) && allowedBasePaths) {
        const isAllowed = allowedBasePaths.some(basePath => {
          const normalizedBase = path.normalize(basePath);
          return normalizedPath.startsWith(normalizedBase);
        });
        
        if (!isAllowed) {
          logger.warn(`[DefaultElementProvider] Absolute path outside allowed directories: ${filePath}`);
          return false;
        }
      }
      
      // SECURITY: Reject null bytes and other dangerous characters
      if (normalizedPath.includes('\0') || normalizedPath.includes('\x00')) { // NOSONAR - Null byte detection for security
        logger.warn(`[DefaultElementProvider] Null byte in path blocked: ${filePath}`);
        return false;
      }
      
      return true;
    } catch (error) {
      logger.warn(`[DefaultElementProvider] Path validation error: ${error}`);
      return false;
    }
  }

  // DEPRECATED: Commented out filename pattern detection - replaced with metadata-based detection
  /**
   * Cached compiled regex patterns for performance optimization
   * @deprecated Use metadata-based detection instead
   */
  // private static compiledTestPatterns: RegExp[] | null = null;

  /**
   * Get compiled test patterns with caching for better performance
   * @deprecated Use metadata-based detection instead
   * @returns Array of compiled regex patterns
   */
  // private getCompiledTestPatterns(): RegExp[] {
  //   // Use cached patterns if available
  //   if (DefaultElementProvider.compiledTestPatterns) {
  //     return DefaultElementProvider.compiledTestPatterns;
  //   }
  //   
  //   // Compile and cache patterns on first use
  //   // CRITICAL FIX: Removed overly broad /^test-/i pattern that was blocking legitimate use
  //   // Users should be able to create personas like "test-driven-developer" or "test-automation-expert"
  //   // We only block specific test patterns that are clearly from our test suite
  //   DefaultElementProvider.compiledTestPatterns = [
  //     /^testpersona/i,              // Our test suite pattern
  //     /^yamltest/i,                 // Security test pattern
  //     /^yamlbomb/i,                 // Security test pattern
  //     /^memory-test-/i,             // Performance test pattern
  //     /^perf-test-/i,               // Performance test pattern
  //     /^test-fixture-/i,            // Test fixture pattern (more specific)
  //     /^test-data-/i,               // Test data pattern (more specific)
  //     /bin-sh|rm-rf|pwned/i,        // Malicious patterns
  //     /concurrent-\d+/i,            // Concurrent test pattern
  //     /legacy\.md$/i,               // Legacy test pattern
  //     /performance-test/i,          // Performance test pattern
  //     /-\d{13}-[a-z0-9]+\.md$/i,    // Timestamp-based test files
  //     /^unittest-/i,                // Unit test pattern
  //     /^integrationtest-/i,         // Integration test pattern
  //   ];
  //   
  //   return DefaultElementProvider.compiledTestPatterns;
  // }

  /**
   * Check if a filename matches test data patterns that should never be copied to production
   * @deprecated Use isDollhouseMCPTestElement() for metadata-based detection instead
   * @param filename The filename to check
   * @returns true if the filename matches test patterns that should be blocked
   */
  // private isTestDataPattern(filename: string): boolean {
  //   const patterns = this.getCompiledTestPatterns();
  //   return patterns.some(pattern => pattern.test(filename));
  // }

  /**
   * Read metadata from YAML frontmatter only (never reads content body)
   * Uses a small buffer to safely extract only the frontmatter between --- markers
   * @param filePath Path to the file to read metadata from
   * @returns Parsed metadata object or null if no frontmatter found
   */
  // PERFORMANCE OPTIMIZATION: Reusable buffer pool to reduce allocations
  private static readonly bufferPool: Buffer[] = [];
  private static readonly MAX_POOL_SIZE = 20; // MEMORY LEAK FIX: Reduced buffer pool size to match cache size for consistent memory management
  private static bufferPoolStats = { hits: 0, misses: 0, created: 0 };
  
  private getBuffer(): Buffer {
    // PERFORMANCE: Track buffer pool usage for optimization monitoring
    let buffer = DefaultElementProvider.bufferPool.pop();
    if (buffer) {
      DefaultElementProvider.bufferPoolStats.hits++;
      return buffer;
    } else {
      DefaultElementProvider.bufferPoolStats.misses++;
      DefaultElementProvider.bufferPoolStats.created++;
      buffer = Buffer.alloc(4096);
      logger.debug(`[DefaultElementProvider] Created new buffer (pool empty), total created: ${DefaultElementProvider.bufferPoolStats.created}`);
      return buffer;
    }
  }
  
  private releaseBuffer(buffer: Buffer): void {
    // CRITICAL FIX: Always attempt to return buffer to pool for reuse
    if (DefaultElementProvider.bufferPool.length < DefaultElementProvider.MAX_POOL_SIZE) {
      buffer.fill(0); // SECURITY: Clear buffer before reuse to prevent data leakage
      DefaultElementProvider.bufferPool.push(buffer);
    } else {
      // PERFORMANCE: If pool is full, clear the buffer to help GC
      buffer.fill(0);
      logger.debug('[DefaultElementProvider] Buffer pool full, discarding buffer');
    }
  }

  /**
   * Clean up buffer pool and cache to free memory
   * PERFORMANCE FIX: Added cleanup method to prevent memory leaks
   * This should be called during application shutdown or periodic cleanup
   */
  public static cleanup(): void {
    // Clear buffer pool
    DefaultElementProvider.bufferPool.length = 0;
    
    // Clear metadata cache
    DefaultElementProvider.metadataCache.clear();
    
    // Clear cached data directory
    DefaultElementProvider.cachedDataDir = null;
    
    // Clear population promises
    DefaultElementProvider.populateInProgress.clear();
    
    logger.info('[DefaultElementProvider] Memory cleanup completed', {
      bufferStats: DefaultElementProvider.bufferPoolStats,
      cacheCleared: true
    });
    
    // Reset stats
    DefaultElementProvider.bufferPoolStats = { hits: 0, misses: 0, created: 0 };
  }

  /**
   * Get performance statistics for monitoring
   * PERFORMANCE MONITORING: Added statistics method for performance tracking
   * This provides insights into buffer pool efficiency and cache performance
   * @returns Object containing performance metrics
   */
  public static getPerformanceStats(): {
    bufferPool: {
      hits: number;
      misses: number; 
      created: number;
      hitRate: number;
      poolSize: number;
      maxPoolSize: number;
    };
    metadataCache: {
      size: number;
      maxSize: number;
    };
  } {
    const bufferHits = DefaultElementProvider.bufferPoolStats.hits;
    const bufferMisses = DefaultElementProvider.bufferPoolStats.misses;
    const totalRequests = bufferHits + bufferMisses;
    
    return {
      bufferPool: {
        hits: bufferHits,
        misses: bufferMisses,
        created: DefaultElementProvider.bufferPoolStats.created,
        hitRate: totalRequests > 0 ? bufferHits / totalRequests : 0,
        poolSize: DefaultElementProvider.bufferPool.length,
        maxPoolSize: DefaultElementProvider.MAX_POOL_SIZE
      },
      metadataCache: {
        size: DefaultElementProvider.metadataCache.size,
        maxSize: DefaultElementProvider.MAX_CACHE_SIZE
      }
    };
  }

  private async readMetadataOnly(filePath: string, retries = 2): Promise<any | null> {
    // PERFORMANCE: Check cache first before reading file
    try {
      const stats = await fs.stat(filePath);
      const cacheKey = filePath;
      const cached = DefaultElementProvider.metadataCache.get(cacheKey);
      
      // Return cached metadata if file hasn't changed 
      // CRITICAL FIX: Use integer mtime comparison to avoid floating-point precision issues
      if (cached && Math.floor(cached.mtime) === Math.floor(stats.mtimeMs) && cached.size === stats.size) {
        logger.debug(`[DefaultElementProvider] Cache hit for ${filePath}`);
        return cached.metadata;
      }
    } catch {
      // File doesn't exist, proceed with normal flow
    }
    
    try {
      // Open file and read only first 4KB to avoid reading dangerous content
      const fd = await fs.open(filePath, 'r');
      // PERFORMANCE: Use buffer pool instead of allocating new buffer each time
      const buffer = this.getBuffer();
      
      try {
        const result = await fd.read(buffer, 0, 4096, 0);
        const header = buffer.subarray(0, result.bytesRead).toString('utf-8');
        
        // Look for YAML frontmatter between --- markers
        // Support both Unix (\n) and Windows (\r\n) line endings
        const match = header.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (!match) {
          return null; // No frontmatter found
        }
        
        // Parse the YAML frontmatter safely
        try {
          // SECURITY FIX: Replace direct YAML parsing function with SecureYamlParser for enhanced security
          // SecureYamlParser provides additional validation, injection prevention, and content sanitization
          // It expects full YAML with --- markers, so we reconstruct the frontmatter block
          // We disable specific field validation as this is general metadata parsing, not persona-specific
          const fullYaml = `---\n${match[1]}\n---`;
          const parseResult = SecureYamlParser.parse(fullYaml, { 
            validateContent: false, 
            validateFields: false 
          });
          const metadata = parseResult.data;
          
          // PERFORMANCE: Cache the metadata with file stats for future reads
          if (typeof metadata === 'object' && metadata !== null) {
            try {
              const stats = await fs.stat(filePath);
              const cacheEntry: MetadataCacheEntry = {
                metadata,
                mtime: stats.mtimeMs,
                size: stats.size
              };
              
              // CRITICAL MEMORY LEAK FIX: More aggressive cache management to prevent unbounded growth
              // Check if this entry already exists and just update it instead of adding new
              if (DefaultElementProvider.metadataCache.has(filePath)) {
                // Update existing entry - no eviction needed
                DefaultElementProvider.metadataCache.set(filePath, cacheEntry);
                logger.debug(`[DefaultElementProvider] Updated existing cache entry for ${filePath}`);
              } else {
                // New entry - check if we need to evict first
                // Use > instead of >= to ensure we never exceed MAX_CACHE_SIZE
                if (DefaultElementProvider.metadataCache.size >= DefaultElementProvider.MAX_CACHE_SIZE) {
                  // More aggressive eviction: remove enough entries to stay well under limit
                  const entriesToEvict = Math.max(1, Math.floor(DefaultElementProvider.MAX_CACHE_SIZE * 0.4));
                  const keysToEvict = Array.from(DefaultElementProvider.metadataCache.keys()).slice(0, entriesToEvict);
                  for (const key of keysToEvict) {
                    DefaultElementProvider.metadataCache.delete(key);
                  }
                  logger.debug(`[DefaultElementProvider] Evicted ${keysToEvict.length} cache entries to manage memory (cache size was ${DefaultElementProvider.metadataCache.size + keysToEvict.length})`);
                }
                
                DefaultElementProvider.metadataCache.set(filePath, cacheEntry);
                logger.debug(`[DefaultElementProvider] Added new cache entry for ${filePath} (cache size now: ${DefaultElementProvider.metadataCache.size})`);
              }
            } catch {
              // Ignore cache errors, return metadata anyway
            }
            return metadata;
          }
          return null;
        } catch (yamlError) {
          // Invalid YAML, return null
          // ENHANCEMENT: Include error type for better debugging
          const yamlErrorType = (yamlError as any)?.constructor?.name || 'YAMLError';
          logger.debug(`[DefaultElementProvider] Invalid YAML in ${filePath}: ${yamlErrorType} - ${yamlError}`);
          return null;
        }
      } finally {
        // CRITICAL FIX: Ensure file descriptor is closed and buffer is released in ALL paths
        try {
          await fd.close();
        } catch (closeError) {
          logger.debug(`[DefaultElementProvider] Error closing file descriptor for ${filePath}: ${closeError}`);
        }
        // PERFORMANCE: Return buffer to pool for reuse
        this.releaseBuffer(buffer);
      }
    } catch (error: any) {
      // ENHANCEMENT: Include error type in debug logs for better debugging
      const errorType = error?.constructor?.name || 'UnknownError';
      const errorCode = error?.code || 'NO_CODE';
      
      // RELIABILITY: Add retry logic for transient failures
      if (retries > 0 && (errorCode === 'EBUSY' || errorCode === 'EAGAIN')) {
        logger.debug(`[DefaultElementProvider] Retrying read for ${filePath} after ${errorType}:${errorCode}`);
        await new Promise(resolve => setTimeout(resolve, 50)); // Brief delay before retry
        return this.readMetadataOnly(filePath, retries - 1);
      }
      
      logger.debug(`[DefaultElementProvider] Could not read metadata from ${filePath}: ${errorType}:${errorCode} - ${error?.message || error}`);
      return null;
    }
  }

  /**
   * Check if a file is a DollhouseMCP test element based on metadata
   * This replaces filename pattern detection with accurate metadata-based detection
   * @param filePath Path to the file to check
   * @returns true if the file contains _dollhouseMCPTest: true metadata
   */
  private async isDollhouseMCPTestElement(filePath: string): Promise<boolean> {
    try {
      const metadata = await this.readMetadataOnly(filePath);
      const isTest = !!(metadata && metadata._dollhouseMCPTest === true);
      
      
      return isTest;
    } catch (error) {
      // If we can't read the metadata, assume it's not a test file
      logger.debug(`[DefaultElementProvider] Error checking test metadata for ${filePath}: ${error}`);
      return false;
    }
  }

  /**
   * Detect if we're in a production environment by checking for production indicators
   * Uses a confidence-based approach requiring multiple indicators for better accuracy
   * @returns true if this appears to be a production environment
   */
  private isProductionEnvironment(): boolean {
    // Allow tests to explicitly override production mode detection
    if (process.env.FORCE_PRODUCTION_MODE === 'true') {
      return true;
    }
    if (process.env.FORCE_PRODUCTION_MODE === 'false') {
      return false;
    }
    
    // Weighted indicators for production detection
    const indicators = {
      // Strong indicators (weight: 2)
      hasUserHomeDir: (process.env.HOME && (process.env.HOME.includes('/Users/') || process.env.HOME.includes('/home/'))) || 
                      !!process.env.USERPROFILE,
      isProductionNode: process.env.NODE_ENV === 'production',
      notInTestDir: (() => {
        const cwd = process.cwd().toLowerCase();
        // Normalize path separators for cross-platform checking (Windows uses \ but checks use /)
        const normalizedCwd = cwd.replaceAll('\\', '/');
        return !normalizedCwd.includes('/test') && 
               !normalizedCwd.includes('/__tests__') && 
               !normalizedCwd.includes('/temp') &&
               !normalizedCwd.includes('/dist/test');
      })(),
      
      // Moderate indicators (weight: 1)
      notInCI: !process.env.CI,
      noTestEnv: process.env.NODE_ENV !== 'test',
      noDevEnv: process.env.NODE_ENV !== 'development',
    };
    
    // Calculate weighted score
    let score = 0;
    if (indicators.hasUserHomeDir) score += 2;
    if (indicators.isProductionNode) score += 2;
    if (indicators.notInTestDir) score += 2;
    if (indicators.notInCI) score += 1;
    if (indicators.noTestEnv) score += 1;
    if (indicators.noDevEnv) score += 1;
    
    // Log detection details for debugging
    const activeIndicators = Object.entries(indicators)
      .filter(([_, value]) => value)
      .map(([key]) => key);
    
    // TYPESCRIPT FIX: Removed logger.isDebugEnabled() check as this method doesn't exist on MCPLogger
    // The logger already handles debug level internally, so we can call debug() directly
    if (score >= 3) {
      logger.debug(
        '[DefaultElementProvider] Production environment detected',
        { score, activeIndicators, forceMode: 'not set' }
      );
    }
    
    // Require a score of at least 3 for production detection (more confident)
    // This prevents false positives in edge cases while maintaining security
    return score >= 3;
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
        
        
        // SECURITY FIX: Validate file paths to prevent path traversal attacks
        // This prevents malicious files from escaping the intended directory structure
        const sourceValid = this.validateFilePath(sourcePath, [sourceDir]);
        const destValid = this.validateFilePath(destPath, [destDir]);
        
        if (!sourceValid || !destValid) {
          logger.warn(
            `[DefaultElementProvider] Skipping file with invalid path: ${normalizedFile.normalizedContent}`,
            { sourcePath, destPath, elementType }
          );
          continue;
        }
        
        // Production safety check: Block DollhouseMCP test elements in production environments
        // Skip this check if loadTestData is explicitly enabled (for testing scenarios)
        if (!this.config.loadTestData && this.isProductionEnvironment()) {
          const isDollhouseTest = await this.isDollhouseMCPTestElement(sourcePath);
          
          if (isDollhouseTest) {
            logger.warn(
              `[DefaultElementProvider] SECURITY: Blocking DollhouseMCP test element in production: ${normalizedFile.normalizedContent}`,
              { 
                file: normalizedFile.normalizedContent,
                reason: 'DollhouseMCP test element detected in production environment',
                elementType
              }
            );
            
            // Log security event for blocked test data
            SecurityMonitor.logSecurityEvent({
              type: 'TEST_DATA_BLOCKED',
              severity: 'MEDIUM',
              source: 'DefaultElementProvider.copyElementFiles',
              details: `Blocked DollhouseMCP test element in production: ${normalizedFile.normalizedContent}`,
              metadata: {
                filename: normalizedFile.normalizedContent,
                elementType,
                reason: 'DollhouseMCP test element detected in production environment',
                detectionMethod: 'metadata-based'
              }
            });
            
            continue;
          }
        }
        
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
          
          // Log security event for each file copied
          SecurityMonitor.logSecurityEvent({
            type: 'FILE_COPIED',
            severity: 'LOW',
            source: 'DefaultElementProvider.copyElementFiles',
            details: `Copied default ${elementType} file: ${normalizedFile.normalizedContent}`,
            metadata: {
              sourcePath,
              destPath,
              elementType,
              fileSize: (await fs.stat(destPath)).size
            }
          });
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
    // Check if test data loading is disabled
    // Note: This check is needed even though constructor sets config, because
    // config can be overridden after construction
    
    // Use production environment detection that respects FORCE_PRODUCTION_MODE
    const isDevelopmentMode = !this.isProductionEnvironment();
    
    if (isDevelopmentMode && !this.config.loadTestData) {
      logger.info(
        '[DefaultElementProvider] Skipping default element population in development mode',
        { 
          portfolioBaseDir,
          reason: 'Test data loading disabled',
          enableWith: 'Set DOLLHOUSE_LOAD_TEST_DATA=true to enable'
        }
      );
      return;
    }
    
    logger.info(
      '[DefaultElementProvider] Starting default element population',
      { portfolioBaseDir }
    );
    
    // Log security event for portfolio initialization
    SecurityMonitor.logSecurityEvent({
      type: 'PORTFOLIO_INITIALIZATION',
      severity: 'LOW',
      source: 'DefaultElementProvider.performPopulation',
      details: `Starting default element population for portfolio: ${portfolioBaseDir}`
    });
    
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
    
    // Copy each element type - directories now match enum values (all plural)
    for (const elementType of Object.values(ElementType)) {
      const sourceDir = path.join(dataDir, elementType);
      const destDir = path.join(portfolioBaseDir, elementType);
      
      try {
        // Check if source directory exists
        await fs.access(sourceDir);
        const copiedCount = await this.copyElementFiles(sourceDir, destDir, elementType);
        copiedCounts[elementType] = copiedCount;
        totalCopied += copiedCount;
      } catch (error) {
        // Source directory doesn't exist, skip
        logger.debug(`[DefaultElementProvider] No ${elementType} directory in bundled data`);
      }
    }
    
    if (totalCopied > 0) {
      logger.info(
        `[DefaultElementProvider] Successfully populated portfolio with ${totalCopied} default element(s)`,
        {
          portfolioBaseDir,
          dataDir,
          breakdown: copiedCounts
        }
      );
      
      // Log security event for successful population
      SecurityMonitor.logSecurityEvent({
        type: 'PORTFOLIO_POPULATED',
        severity: 'LOW',
        source: 'DefaultElementProvider.performPopulation',
        details: `Successfully populated portfolio with ${totalCopied} default elements`,
        metadata: {
          portfolioBaseDir,
          dataDir,
          copiedCounts
        }
      });
    } else {
      logger.info('[DefaultElementProvider] No new elements to copy - portfolio may already have content');
    }
  }
}