/**
 * Portfolio Manager - Manages the portfolio directory structure for all element types
 */


import * as path from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';
import { ElementType, PortfolioConfig } from './types.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { DefaultElementProvider } from './DefaultElementProvider.js';
import { ErrorHandler, ErrorCategory } from '../utils/ErrorHandler.js';
import { FileOperationsService } from '../services/FileOperationsService.js';

// Constants
const ELEMENT_FILE_EXTENSIONS: Record<ElementType, string> = {
  [ElementType.PERSONA]: '.md',
  [ElementType.SKILL]: '.md',
  [ElementType.TEMPLATE]: '.md',
  [ElementType.AGENT]: '.md',
  [ElementType.MEMORY]: '.yaml',
  [ElementType.ENSEMBLE]: '.md'
};

// Default extension for backward compatibility
const DEFAULT_ELEMENT_FILE_EXTENSION = '.md';

/**
 * Get the file extension for an element type without requiring a PortfolioManager instance.
 * Issue #815: Shared by PortfolioRepoManager and submitToPortfolioTool to avoid
 * hardcoded '.md' assumptions.
 */
export function getElementFileExtension(type: string): string {
  return ELEMENT_FILE_EXTENSIONS[type as ElementType] || DEFAULT_ELEMENT_FILE_EXTENSION;
}

export { ElementType };
export type { PortfolioConfig };

export class PortfolioManager {
  private initializationPromise: Promise<void> | null = null;
  private baseDir: string;
  private fileOperations: FileOperationsService;

  /**
   * Create a new PortfolioManager instance
   *
   * @param config - Optional portfolio configuration
   * @param fileOperations - Optional FileOperationsService for dependency injection.
   *                         BREAKING CHANGE (v1.5.0): Added as second parameter for DI.
   *                         Direct instantiation without DI container should pass undefined
   *                         or provide a FileOperationsService instance.
   */
  constructor(fileOperations: FileOperationsService, config?: PortfolioConfig) {
    this.fileOperations = fileOperations;
    // Get potential directory from environment or config
    const envDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;
    const configDir = config?.baseDir;
    const defaultDir = path.join(homedir(), '.dollhouse', 'portfolio');
    
    // Validate environment variable if provided
    if (envDir) {
      if (!path.isAbsolute(envDir)) {
        throw new Error('DOLLHOUSE_PORTFOLIO_DIR must be an absolute path');
      }
      // Additional validation for suspicious paths
      if (envDir.includes('..') || envDir.startsWith('/etc') || envDir.startsWith('/sys')) {
        throw new Error('DOLLHOUSE_PORTFOLIO_DIR contains suspicious path segments');
      }
    }
    
    // Validate config directory if provided
    if (configDir && !path.isAbsolute(configDir)) {
      throw new Error('Portfolio config baseDir must be an absolute path');
    }
    
    // Use environment variable if set, otherwise config, otherwise default
    this.baseDir = envDir || configDir || defaultDir;
    
    logger.info(`[PortfolioManager] Portfolio base directory: ${this.baseDir}`);
  }
  
  /**
   * Get the base portfolio directory
   */
  public getBaseDir(): string {
    return this.baseDir;
  }
  
  /**
   * Get the directory for a specific element type
   */
  public getElementDir(type: ElementType): string {
    return path.join(this.baseDir, type);
  }

  /**
   * Get the file extension for a specific element type
   * FIX (#1213): Expose ELEMENT_FILE_EXTENSIONS mapping for correct extension display
   */
  public getFileExtension(type: ElementType): string {
    return ELEMENT_FILE_EXTENSIONS[type] || DEFAULT_ELEMENT_FILE_EXTENSION;
  }

  /**
   * Initialize the portfolio directory structure
   * Uses locking to prevent race conditions during concurrent initialization
   */
  public async initialize(): Promise<void> {
    // If already initializing, wait for the existing initialization
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    // Check if portfolio is fully initialized (base dir + all subdirectories exist)
    if (await this.isFullyInitialized()) {
      logger.debug('[PortfolioManager] Portfolio already fully initialized');
      return;
    }

    // Create initialization promise to prevent concurrent initialization
    this.initializationPromise = this.performInitialization();

    try {
      await this.initializationPromise;
    } finally {
      // Clear the promise after completion
      this.initializationPromise = null;
    }
  }
  
  /**
   * Perform the actual initialization - should only be called once
   */
  private async performInitialization(): Promise<void> {
    logger.info('[PortfolioManager] Initializing portfolio directory structure');
    
    // Create base directory
    try {
      await this.fileOperations.createDirectory(this.baseDir);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      // In read-only environments (like Docker), we can't create directories
      // Log but continue - the portfolio will be empty but functional
      if (err.code === 'EACCES' || err.code === 'EROFS' || err.code === 'ENOENT') {
        logger.warn(`[PortfolioManager] Cannot create portfolio directory (read-only environment?): ${err.message}`);
        logger.info(`[DollhouseMCP] Running in read-only mode - portfolio features disabled`);
        return;
      }
      throw error;
    }
    
    // Create subdirectories for each element type
    for (const elementType of Object.values(ElementType)) {
      const elementDir = path.join(this.baseDir, elementType);
      await this.fileOperations.createDirectory(elementDir);
      logger.debug(`[PortfolioManager] Created directory: ${elementDir}`);
    }
    
    // Create special directories for stateful elements
    const agentStateDir = path.join(this.baseDir, ElementType.AGENT, '.state');
    await this.fileOperations.createDirectory(agentStateDir);
    
    logger.info('[PortfolioManager] Portfolio directory structure initialized');
    
    // Migration for v1.4.2 users: rename singular directories to plural
    await this.migrateFromSingularDirectories();
    
    // Populate with default elements if this is a new installation
    // Skip during tests to avoid interference
    if (process.env.NODE_ENV !== 'test') {
      try {
        const defaultProvider = new DefaultElementProvider();
        await defaultProvider.populateDefaults(this.baseDir);
      } catch (error) {
        logger.error('[PortfolioManager] Error populating default elements:', error);
        // Log to stderr for MCP client visibility
        logger.error(`[PortfolioManager] CRITICAL: Failed to populate default elements: ${error instanceof Error ? error.message : String(error)}`);
        // Continue anyway - empty portfolio is valid
      }
    }
  }
  
  /**
   * Check if portfolio directory exists
   */
  public async exists(): Promise<boolean> {
    try {
      return await this.fileOperations.exists(this.baseDir);
    } catch {
      return false;
    }
  }

  /**
   * Check if portfolio is fully initialized (base dir + all subdirectories exist)
   * This prevents the bug where base dir exists but subdirectories were deleted
   */
  private async isFullyInitialized(): Promise<boolean> {
    // First check if base directory exists
    if (!await this.exists()) {
      return false;
    }

    // Check if all required subdirectories exist
    try {
      for (const elementType of Object.values(ElementType)) {
        const elementDir = path.join(this.baseDir, elementType);
        if (!await this.fileOperations.exists(elementDir)) return false;
      }

      // Check special directories
      const agentStateDir = path.join(this.baseDir, ElementType.AGENT, '.state');
      if (!await this.fileOperations.exists(agentStateDir)) return false;

      return true;
    } catch {
      // If any subdirectory is missing, portfolio is not fully initialized
      return false;
    }
  }
  
  /**
   * Check if a filename appears to be a test element
   * SAFETY: Pattern-based filtering only, no content parsing
   *
   * This method IDENTIFIES test patterns (always returns true for test files).
   * The actual FILTERING decision (whether to exclude them) is made in listElements().
   */
  public isTestElement(filename: string): boolean {
    // Dangerous test patterns that should never appear in production
    const dangerousPatterns = [
      /^bin-sh/i,
      /^rm-rf/i,
      /^nc-e-bin/i,
      /^python-c-import/i,
      /^curl.*evil/i,
      /^wget.*malicious/i,
      /^eval-/i,
      /^exec-/i,
      /^bash-c-/i,
      /^sh-c-/i,
      /^powershell-/i,
      /^cmd-c-/i,
      /shell-injection/i
    ];

    // NOTE: Test-pattern filtering removed entirely (Issue #287)
    // Users can legitimately create elements with "test" in the name.
    // Only dangerous patterns (security concerns) are filtered.

    // Check dangerous patterns only
    if (dangerousPatterns.some(pattern => pattern.test(filename))) {
      logger.warn(`[PortfolioManager] Filtered dangerous element: ${filename}`);
      return true;
    }

    return false;
  }

  /**
   * List all elements of a specific type
   */
  public async listElements(type: ElementType): Promise<string[]> {
    const elementDir = this.getElementDir(type);
    const fileExtension = ELEMENT_FILE_EXTENSIONS[type] || DEFAULT_ELEMENT_FILE_EXTENSION;

    try {
      const files = await this.fileOperations.listDirectory(elementDir);
      // Filter for correct file extension based on element type
      let filteredFiles = files.filter(file => file.endsWith(fileExtension));

      // Issue #654: Exclude backup files from all element types.
      // Safety net — MemoryStorageLayer also filters, but any code path that
      // calls listElements() directly should never return backup artifacts.
      filteredFiles = filteredFiles.filter(file =>
        !file.includes('.backup-') && !file.includes('.backup.')
      );

      // Filter out test/dangerous elements unless explicitly disabled
      // DISABLE_ELEMENT_FILTERING can be set in E2E tests that need test elements
      // Integration tests and production both use filtering by default
      const shouldFilter = process.env.DISABLE_ELEMENT_FILTERING !== 'true';
      if (shouldFilter) {
        filteredFiles = filteredFiles.filter(file => !this.isTestElement(file));
      }

      return filteredFiles;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      
      if (err.code === 'ENOENT') {
        // Directory doesn't exist yet - this is expected for new installations
        logger.debug(`[PortfolioManager] Element directory doesn't exist yet: ${elementDir}`);
        return [];
      }
      
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        // Permission denied - log but return empty array
        ErrorHandler.logError('PortfolioManager.listElements', error, { elementDir });
        return [];
      }
      
      if (err.code === 'ENOTDIR') {
        // Path exists but is not a directory
        ErrorHandler.logError('PortfolioManager.listElements', error, { elementDir });
        throw ErrorHandler.createError(`Path is not a directory: ${elementDir}`, ErrorCategory.SYSTEM_ERROR);
      }
      
      // For any other errors, throw with context
      ErrorHandler.logError('PortfolioManager.listElements', error, { elementDir });
      throw ErrorHandler.wrapError(error, 'Failed to list elements', ErrorCategory.SYSTEM_ERROR);
    }
  }
  
  /**
   * Get full path to an element file
   */
  public getElementPath(type: ElementType, filename: string): string {
    // Validate filename to prevent path traversal
    if (!filename || typeof filename !== 'string') {
      SecurityMonitor.logSecurityEvent({
        type: 'PATH_TRAVERSAL_ATTEMPT',
        severity: 'MEDIUM',
        source: 'PortfolioManager.getElementPath',
        details: `Invalid filename provided: ${typeof filename}`,
        additionalData: { elementType: type, filename: String(filename) }
      });
      throw new Error('Invalid filename: must be a non-empty string');
    }
    
    // Check for path traversal attempts
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\') || path.isAbsolute(filename)) {
      SecurityMonitor.logSecurityEvent({
        type: 'PATH_TRAVERSAL_ATTEMPT',
        severity: 'HIGH',
        source: 'PortfolioManager.getElementPath',
        details: `Path traversal attempt detected in filename: ${filename}`,
        additionalData: { elementType: type, filename }
      });
      throw new Error(`Invalid filename: contains path traversal characters: ${filename}`);
    }
    
    // Additional validation for hidden files and special characters
    if (filename.startsWith('.') || filename.includes('\0')) {
      SecurityMonitor.logSecurityEvent({
        type: 'PATH_TRAVERSAL_ATTEMPT',
        severity: 'MEDIUM',
        source: 'PortfolioManager.getElementPath',
        details: `Invalid filename characters detected: ${filename}`,
        additionalData: { elementType: type, filename, hasHiddenFile: filename.startsWith('.'), hasNullByte: filename.includes('\0') }
      });
      throw new Error(`Invalid filename: contains invalid characters: ${filename}`);
    }
    
    // Ensure filename ends with .md
    const safeFilename = filename.endsWith('.md') ? filename : `${filename}.md`;
    return path.join(this.getElementDir(type), safeFilename);
  }
  
  /**
   * Check if an element exists
   */
  public async elementExists(type: ElementType, filename: string): Promise<boolean> {
    try {
      return await this.fileOperations.exists(this.getElementPath(type, filename));
    } catch {
      return false;
    }
  }
  
  /**
   * Get legacy personas directory path (for migration)
   */
  public getLegacyPersonasDir(): string {
    return path.join(homedir(), '.dollhouse', 'personas');
  }
  
  /**
   * Check if legacy personas directory exists
   */
  public async hasLegacyPersonas(): Promise<boolean> {
    try {
      const legacyDir = this.getLegacyPersonasDir();
      if (!await this.fileOperations.exists(legacyDir)) return false;
      const files = await this.fileOperations.listDirectory(legacyDir);
      return files.some(file => file.endsWith('.md'));
    } catch {
      return false;
    }
  }
  
  /**
   * Get portfolio statistics
   */
  public async getStatistics(): Promise<Record<ElementType, number>> {
    const stats: Record<string, number> = {};
    
    for (const elementType of Object.values(ElementType)) {
      const elements = await this.listElements(elementType);
      stats[elementType] = elements.length;
    }
    
    return stats as Record<ElementType, number>;
  }
  
  /**
   * Migrate from v1.4.2 singular directory names to v1.4.3 plural names
   * This handles the upgrade path for existing users
   */
  private async migrateFromSingularDirectories(): Promise<void> {
    const oldToNew: Record<string, string> = {
      'persona': 'personas',
      'skill': 'skills',
      'template': 'templates',
      'agent': 'agents',
      'memory': 'memories',
      'ensemble': 'ensembles'
    };
    
    for (const [oldName, newName] of Object.entries(oldToNew)) {
      // Unicode normalize the directory names (even though they're hardcoded, for security audit)
      const normalizedOld = UnicodeValidator.normalize(oldName);
      const normalizedNew = UnicodeValidator.normalize(newName);
      
      if (!normalizedOld.isValid || !normalizedNew.isValid) {
        // This should never happen with our hardcoded values, but for completeness
        logger.error(`[PortfolioManager] Invalid Unicode in directory names during migration`);
        continue;
      }
      
      const oldDir = path.join(this.baseDir, normalizedOld.normalizedContent);
      const newDir = path.join(this.baseDir, normalizedNew.normalizedContent);
      
      try {
        // Check if old directory exists
        if (!await this.fileOperations.exists(oldDir)) continue;
        
        // Check if new directory already has content
        try {
          if (await this.fileOperations.exists(newDir)) {
            const newDirFiles = await this.fileOperations.listDirectory(newDir);
            if (newDirFiles.length > 0) {
              logger.warn(
                `[PortfolioManager] Both ${oldName} and ${newName} directories exist. Keeping ${newName}, skipping migration.`,
                { oldDir, newDir, fileCount: newDirFiles.length }
              );
              continue;
            }
          }
        } catch {
          // New directory doesn't exist or is empty, proceed with migration
        }
        
        // Perform the migration
        logger.info(`[PortfolioManager] Migrating ${oldName} → ${newName}`);
        await this.fileOperations.renameFile(oldDir, newDir);
        
        // Log security event for audit trail
        SecurityMonitor.logSecurityEvent({
          type: 'DIRECTORY_MIGRATION',
          severity: 'LOW',
          source: 'PortfolioManager.migrateFromSingularDirectories',
          details: `Migrated directory from ${oldName} to ${newName} for v1.4.3 compatibility`,
          metadata: { oldDir, newDir }
        });
        
      } catch (error) {
        // Old directory doesn't exist, which is fine
        if ((error as any).code !== 'ENOENT') {
          logger.error(`[PortfolioManager] Error during migration of ${oldName}:`, error);
        }
      }
    }
  }
}
