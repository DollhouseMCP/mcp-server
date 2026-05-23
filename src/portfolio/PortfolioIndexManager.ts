/**
 * Portfolio Index Manager - Maps element names to file paths
 * 
 * Solves critical issues:
 * 1. submit_collection_content can't find elements by metadata name (e.g., "Safe Roundtrip Tester" -> "safe-roundtrip-tester.md")
 * 2. search_collection doesn't search local portfolio content
 * 
 * Features:
 * - In-memory index mapping metadata.name → file path
 * - Keywords/tags → file paths mapping
 * - Element type → file paths mapping
 * - Fast O(1) lookups with Maps
 * - Lazy loading with 5-minute TTL cache
 * - Unicode normalization for security
 * - Error handling and logging
 */

import * as path from 'path';
import * as yaml from 'js-yaml';
import { logger } from '../utils/logger.js';
import { ElementType } from './types.js';
import { PortfolioManager } from './PortfolioManager.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { ErrorHandler, ErrorCategory } from '../utils/ErrorHandler.js';
import { IndexConfigManager } from './config/IndexConfig.js';
import { IFileOperationsService } from '../services/FileOperationsService.js';

export interface IndexEntry {
  filePath: string;
  elementType: ElementType;
  metadata: {
    name: string;
    description?: string;
    version?: string;
    author?: string;
    tags?: string[];
    keywords?: string[];
    triggers?: string[];
    category?: string;
    created?: string;
    updated?: string;
    /** Agent V2 `activates` field — maps element types to element names.
     *  Uses Record<string, string[]> intentionally (not AgentActivates) to
     *  avoid coupling the index layer to agent-specific types and to support
     *  future element types without index changes. */
    activates?: Record<string, string[]>;
  };
  lastModified: Date;
  filename: string; // Base filename without extension
}

// Extended interface for sharded memory entries
export interface ShardedMemoryIndexEntry extends IndexEntry {
  shardInfo: {
    shardCount: number;
    shardDir: string;
    metadataFile: string;
  };
}

export interface PortfolioIndex {
  byName: Map<string, IndexEntry>;
  byFilename: Map<string, IndexEntry>;
  byType: Map<ElementType, IndexEntry[]>;
  byKeyword: Map<string, IndexEntry[]>;
  byTag: Map<string, IndexEntry[]>;
  byTrigger: Map<string, IndexEntry[]>;
}

export interface SearchOptions {
  elementType?: ElementType;
  fuzzyMatch?: boolean;
  maxResults?: number;
  includeKeywords?: boolean;
  includeTags?: boolean;
  includeTriggers?: boolean;
  includeDescriptions?: boolean;
}

export interface SearchResult {
  entry: IndexEntry;
  matchType: 'name' | 'filename' | 'keyword' | 'tag' | 'trigger' | 'description';
  score: number; // For future ranking
}

interface SearchAccumulator {
  results: SearchResult[];
  seenPaths: Set<string>;
  maxResults: number;
}

interface BuildStats {
  totalFiles: number;
  processedFiles: number;
}

interface DirectoryEntries {
  directories: string[];
  yamlFiles: string[];
}

export class PortfolioIndexManager {
  private readonly indexByNamespace = new Map<string, PortfolioIndex>();
  private readonly lastBuiltByNamespace = new Map<string, Date>();
  private readonly TTL_MS: number;
  private readonly portfolioManager: PortfolioManager;
  private readonly fileOperations: IFileOperationsService;
  private readonly buildingByNamespace = new Map<string, Promise<void>>();

  // Retry configuration for file operations
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_MS = 100;

  public constructor(
    private readonly indexConfigManager: IndexConfigManager,
    portfolioManager: PortfolioManager,
    fileOperations: IFileOperationsService
  ) {
    logger.debug('PortfolioIndexManager created');
    this.TTL_MS = this.indexConfigManager.getConfig().index.ttlMinutes * 60 * 1000;
    this.portfolioManager = portfolioManager;
    this.fileOperations = fileOperations;
  }

  /**
   * Retry wrapper for file system operations
   * Handles transient file system errors with exponential backoff
   */
  private async retryFileOperation<T>(
    operation: () => Promise<T>,
    context: string,
    retries: number = this.MAX_RETRIES
  ): Promise<T | null> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const isLastAttempt = attempt === retries;
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Check if error is retryable (transient file system errors)
        const isRetryable = errorMessage.includes('EBUSY') ||
                           errorMessage.includes('EAGAIN') ||
                           errorMessage.includes('ENOENT') ||
                           errorMessage.includes('ETIMEDOUT');

        if (isLastAttempt || !isRetryable) {
          logger.warn(`File operation failed after ${attempt} attempts: ${context}`, {
            error: errorMessage,
            attempt,
            context
          });
          return null;
        }

        // Exponential backoff
        const delay = this.RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        logger.debug(`Retrying file operation: ${context}`, {
          attempt,
          nextDelay: delay,
          error: errorMessage
        });

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    return null;
  }

  /**
   * Get the current index, building it if necessary
   */
  public async getIndex(): Promise<PortfolioIndex> {
    // Check if we need to rebuild
    if (this.needsRebuild()) {
      await this.buildIndex();
    }
    
    return this.indexByNamespace.get(this.currentNamespace())!;
  }

  /**
   * Search the portfolio index by name with fuzzy matching
   */
  public async findByName(name: string, options: SearchOptions = {}): Promise<IndexEntry | null> {
    const index = await this.getIndex();
    
    // Normalize input for security
    const normalizedName = UnicodeValidator.normalize(name);
    if (!normalizedName.isValid) {
      logger.warn('Invalid Unicode in search name', {
        issues: normalizedName.detectedIssues
      });
      return null;
    }
    
    const safeName = normalizedName.normalizedContent;
    
    // Try exact match first (case insensitive)
    const exactMatch = index.byName.get(safeName.toLowerCase());
    if (exactMatch) {
      logger.debug('Found exact name match', { name: safeName, filePath: exactMatch.filePath });
      return exactMatch;
    }
    
    // Try filename match
    const filenameMatch = index.byFilename.get(safeName.toLowerCase());
    if (filenameMatch) {
      logger.debug('Found filename match', { name: safeName, filePath: filenameMatch.filePath });
      return filenameMatch;
    }
    
    // Try fuzzy matching if enabled
    if (options.fuzzyMatch !== false) {
      const fuzzyMatch = this.findFuzzyMatch(safeName, index, options);
      if (fuzzyMatch) {
        logger.debug('Found fuzzy match', { 
          name: safeName, 
          matchName: fuzzyMatch.metadata.name,
          filePath: fuzzyMatch.filePath 
        });
        return fuzzyMatch;
      }
    }
    
    logger.debug('No match found for name', { name: safeName });
    return null;
  }

  /**
   * Search the portfolio with comprehensive text search
   */
  public async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const index = await this.getIndex();
    const safeQuery = this.normalizeSearchQuery(query);
    if (!safeQuery) return [];

    const queryTokens = this.tokenizeSearchQuery(safeQuery);
    
    if (queryTokens.length === 0) {
      return [];
    }
    
    const accumulator: SearchAccumulator = {
      results: [],
      seenPaths: new Set<string>(),
      maxResults: options.maxResults || 20,
    };
    
    this.searchDirectIndex(index.byName, queryTokens, accumulator, options, 'name', 3);
    this.searchDirectIndex(index.byFilename, queryTokens, accumulator, options, 'filename', 2.5);
    this.searchGroupedIndex(index.byKeyword, queryTokens, accumulator, options, 'keyword', 2, options.includeKeywords);
    this.searchGroupedIndex(index.byTag, queryTokens, accumulator, options, 'tag', 2, options.includeTags);
    this.searchGroupedIndex(index.byTrigger, queryTokens, accumulator, options, 'trigger', 1.8, options.includeTriggers);
    this.searchDescriptions(index, queryTokens, accumulator, options);
    
    // Sort by score (descending)
    accumulator.results.sort((a, b) => b.score - a.score);
    
    logger.debug('Portfolio search completed', {
      query: safeQuery,
      resultCount: accumulator.results.length,
      totalIndexed: index.byName.size
    });
    
    return accumulator.results;
  }

  private normalizeSearchQuery(query: string): string | null {
    const normalizedQuery = UnicodeValidator.normalize(query);
    if (normalizedQuery.isValid) {
      return normalizedQuery.normalizedContent.toLowerCase().trim();
    }
    logger.warn('Invalid Unicode in search query', {
      issues: normalizedQuery.detectedIssues
    });
    return null;
  }

  private tokenizeSearchQuery(safeQuery: string): string[] {
    return safeQuery.split(/\s+/).filter(token => token.length > 0);
  }

  private searchDirectIndex(
    source: Map<string, IndexEntry>,
    queryTokens: string[],
    accumulator: SearchAccumulator,
    options: SearchOptions,
    matchType: SearchResult['matchType'],
    score: number,
  ): void {
    for (const [value, entry] of source) {
      if (this.matchesQuery(value, queryTokens)) {
        this.addSearchResult(entry, matchType, score, accumulator, options);
      }
    }
  }

  private searchGroupedIndex(
    source: Map<string, IndexEntry[]>,
    queryTokens: string[],
    accumulator: SearchAccumulator,
    options: SearchOptions,
    matchType: SearchResult['matchType'],
    score: number,
    include: boolean | undefined,
  ): void {
    if (include === false) return;
    for (const [value, entries] of source) {
      if (this.matchesQuery(value, queryTokens)) {
        for (const entry of entries) {
          this.addSearchResult(entry, matchType, score, accumulator, options);
        }
      }
    }
  }

  private searchDescriptions(
    index: PortfolioIndex,
    queryTokens: string[],
    accumulator: SearchAccumulator,
    options: SearchOptions,
  ): void {
    if (options.includeDescriptions === false) return;
    for (const [, entry] of index.byName) {
      if (entry.metadata.description &&
          this.matchesQuery(entry.metadata.description.toLowerCase(), queryTokens)) {
        this.addSearchResult(entry, 'description', 1.5, accumulator, options);
      }
    }
  }

  private addSearchResult(
    entry: IndexEntry,
    matchType: SearchResult['matchType'],
    score: number,
    accumulator: SearchAccumulator,
    options: SearchOptions,
  ): void {
    if (accumulator.seenPaths.has(entry.filePath) || accumulator.results.length >= accumulator.maxResults) return;
    if (options.elementType && entry.elementType !== options.elementType) return;

    accumulator.seenPaths.add(entry.filePath);
    accumulator.results.push({ entry, matchType, score });
  }

  /**
   * Get all elements of a specific type
   */
  public async getElementsByType(elementType: ElementType): Promise<IndexEntry[]> {
    const index = await this.getIndex();
    return index.byType.get(elementType) || [];
  }

  /**
   * Get statistics about the index
   */
  public async getStats(): Promise<{
    totalElements: number;
    elementsByType: Record<ElementType, number>;
    lastBuilt: Date | null;
    isStale: boolean;
  }> {
    const index = await this.getIndex();
    const stats = {
      totalElements: index.byName.size,
      elementsByType: {} as Record<ElementType, number>,
      lastBuilt: this.lastBuiltByNamespace.get(this.currentNamespace()) ?? null,
      isStale: this.needsRebuild()
    };
    
    for (const elementType of Object.values(ElementType)) {
      stats.elementsByType[elementType] = (index.byType.get(elementType) || []).length;
    }
    
    return stats;
  }

  /**
   * Force rebuild the index
   */
  public async rebuildIndex(): Promise<void> {
    const namespace = this.currentNamespace();
    this.indexByNamespace.delete(namespace);
    this.lastBuiltByNamespace.delete(namespace);
    await this.buildIndex();
  }

  /**
   * Check if the index needs rebuilding
   */
  private needsRebuild(): boolean {
    const namespace = this.currentNamespace();
    const index = this.indexByNamespace.get(namespace);
    const lastBuilt = this.lastBuiltByNamespace.get(namespace);
    if (!index || !lastBuilt) {
      return true;
    }
    
    const age = Date.now() - lastBuilt.getTime();
    return age > this.TTL_MS;
  }

  private currentNamespace(): string {
    return this.portfolioManager.getElementDir(ElementType.PERSONA);
  }

  public getCacheNamespace(): string {
    return this.currentNamespace();
  }

  /**
   * Build the index by scanning all portfolio directories
   */
  private async buildIndex(): Promise<void> {
    const namespace = this.currentNamespace();
    // Prevent concurrent builds
    const existingBuild = this.buildingByNamespace.get(namespace);
    if (existingBuild) {
      await existingBuild;
      return;
    }
    
    const buildPromise = this.performBuild(namespace);
    this.buildingByNamespace.set(namespace, buildPromise);
    
    try {
      await buildPromise;
    } finally {
      this.buildingByNamespace.delete(namespace);
    }
  }

  /**
   * Perform the actual index building
   */
  private async performBuild(namespace: string): Promise<void> {
    const startTime = Date.now();
    logger.debug('Building portfolio index...');
    
    try {
      const newIndex = this.createEmptyIndex();
      const stats: BuildStats = { totalFiles: 0, processedFiles: 0 };

      for (const elementType of Object.values(ElementType)) {
        this.addBuildStats(stats, await this.scanElementType(elementType, newIndex));
      }
      
      this.updateIndexAtomically(namespace, newIndex, stats, startTime);
    } catch (error) {
      ErrorHandler.logError('PortfolioIndexManager.performBuild', error);
      throw ErrorHandler.wrapError(error, 'Failed to build portfolio index', ErrorCategory.SYSTEM_ERROR);
    }
  }

  private createEmptyIndex(): PortfolioIndex {
    const newIndex: PortfolioIndex = {
      byName: new Map(),
      byFilename: new Map(),
      byType: new Map(),
      byKeyword: new Map(),
      byTag: new Map(),
      byTrigger: new Map()
    };

    for (const elementType of Object.values(ElementType)) {
      newIndex.byType.set(elementType, []);
    }

    return newIndex;
  }

  private async scanElementType(elementType: ElementType, newIndex: PortfolioIndex): Promise<BuildStats> {
    try {
      const elementDir = this.portfolioManager.getElementDir(elementType);
      const dirExists = await this.fileOperations.exists(elementDir);
      if (!dirExists) {
        logger.debug(`Element directory doesn't exist: ${elementDir}`);
        return { totalFiles: 0, processedFiles: 0 };
      }

      return elementType === ElementType.MEMORY
        ? this.scanMemoryDirectory(elementDir, newIndex)
        : this.scanStandardElementDirectory(elementDir, elementType, newIndex);
    } catch (error) {
      logger.error(`Failed to scan element type: ${elementType}`, {
        error: error instanceof Error ? error.message : String(error)
      });
      return { totalFiles: 0, processedFiles: 0 };
    }
  }

  private async scanStandardElementDirectory(
    elementDir: string,
    elementType: ElementType,
    newIndex: PortfolioIndex,
  ): Promise<BuildStats> {
    const files = await this.fileOperations.listDirectory(elementDir);
    const mdFiles = files.filter(file => file.endsWith('.md'));
    let processedFiles = 0;

    for (const file of mdFiles) {
      const indexed = await this.indexStandardFile(elementDir, file, elementType, newIndex);
      if (indexed) processedFiles++;
    }

    return { totalFiles: mdFiles.length, processedFiles };
  }

  private async indexStandardFile(
    elementDir: string,
    file: string,
    elementType: ElementType,
    newIndex: PortfolioIndex,
  ): Promise<boolean> {
    try {
      const filePath = path.join(elementDir, file);
      const entry = await this.createIndexEntry(filePath, elementType);
      if (!entry) return false;

      this.addToIndex(newIndex, entry);
      return true;
    } catch (error) {
      logger.warn(`Failed to index file: ${file}`, {
        elementType,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  private async scanMemoryDirectory(elementDir: string, newIndex: PortfolioIndex): Promise<BuildStats> {
    const rootEntries = await this.listDirectoryEntries(elementDir);
    const stats = await this.indexMemoryFiles(elementDir, rootEntries.yamlFiles, newIndex, {
      message: 'Failed to index root memory file',
      location: 'root',
    });

    const dateFolders = rootEntries.directories.filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name));
    for (const dateFolder of dateFolders) {
      this.addBuildStats(stats, await this.indexMemoryDateFolder(elementDir, dateFolder, newIndex));
    }

    return stats;
  }

  private async indexMemoryDateFolder(
    elementDir: string,
    dateFolder: string,
    newIndex: PortfolioIndex,
  ): Promise<BuildStats> {
    const folderPath = path.join(elementDir, dateFolder);
    const folderEntries = await this.listDirectoryEntries(folderPath);
    const stats = await this.indexMemoryFiles(folderPath, folderEntries.yamlFiles, newIndex, {
      message: 'Failed to index date folder memory file',
      location: 'date-folder',
      dateFolder,
    });

    for (const subDir of folderEntries.directories) {
      this.addBuildStats(stats, await this.indexShardedMemory(folderPath, dateFolder, subDir, newIndex));
    }

    return stats;
  }

  private async listDirectoryEntries(dir: string): Promise<DirectoryEntries> {
    const entryNames = await this.fileOperations.listDirectory(dir);
    const directories: string[] = [];
    const yamlFiles: string[] = [];

    for (const entryName of entryNames) {
      const entryPath = path.join(dir, entryName);
      try {
        const entryStat = await this.fileOperations.stat(entryPath);
        if (entryStat.isDirectory()) {
          directories.push(entryName);
        } else if (entryName.endsWith('.yaml')) {
          yamlFiles.push(entryName);
        }
      } catch {
        // Skip entries we can't stat.
      }
    }

    return { directories, yamlFiles };
  }

  private async indexMemoryFiles(
    baseDir: string,
    files: string[],
    newIndex: PortfolioIndex,
    context: { message: string; location: string; dateFolder?: string },
  ): Promise<BuildStats> {
    const stats: BuildStats = { totalFiles: 0, processedFiles: 0 };

    for (const file of files) {
      const indexed = await this.indexMemoryFile(baseDir, file, newIndex, context);
      if (indexed) {
        stats.processedFiles++;
        stats.totalFiles++;
      }
    }

    return stats;
  }

  private async indexMemoryFile(
    baseDir: string,
    file: string,
    newIndex: PortfolioIndex,
    context: { message: string; location: string; dateFolder?: string },
  ): Promise<boolean> {
    try {
      const filePath = path.join(baseDir, file);
      const entry = await this.createMemoryIndexEntry(filePath, ElementType.MEMORY);
      if (!entry) return false;

      this.addToIndex(newIndex, entry);
      return true;
    } catch (error) {
      logger.warn(context.message, {
        file,
        path: path.join(baseDir, file),
        ...(context.dateFolder ? { dateFolder: context.dateFolder } : {}),
        location: context.location,
        error: error instanceof Error ? error.message : String(error),
        errorType: error instanceof Error ? error.constructor.name : typeof error
      });
      return false;
    }
  }

  private async indexShardedMemory(
    folderPath: string,
    dateFolder: string,
    subDir: string,
    newIndex: PortfolioIndex,
  ): Promise<BuildStats> {
    const subDirPath = path.join(folderPath, subDir);
    const shardFiles = await this.fileOperations.listDirectory(subDirPath);
    const shardYamlFiles = shardFiles.filter(file => file.endsWith('.yaml'));
    const metadataFile = this.pickShardedMemoryMetadataFile(shardYamlFiles, subDir);
    if (!metadataFile) return { totalFiles: 0, processedFiles: 0 };

    const indexed = await this.indexShardedMemoryMetadata(
      subDirPath,
      dateFolder,
      subDir,
      metadataFile,
      shardYamlFiles,
      newIndex,
    );
    return indexed ? { totalFiles: 1, processedFiles: 1 } : { totalFiles: 0, processedFiles: 0 };
  }

  private pickShardedMemoryMetadataFile(shardYamlFiles: string[], subDir: string): string | undefined {
    return shardYamlFiles.find(file => file === 'metadata.yaml') ||
      shardYamlFiles.find(file => file === `${subDir}.yaml`) ||
      shardYamlFiles[0];
  }

  private async indexShardedMemoryMetadata(
    subDirPath: string,
    dateFolder: string,
    subDir: string,
    metadataFile: string,
    shardYamlFiles: string[],
    newIndex: PortfolioIndex,
  ): Promise<boolean> {
    try {
      const filePath = path.join(subDirPath, metadataFile);
      const entry = await this.createMemoryIndexEntry(filePath, ElementType.MEMORY);
      if (!entry) return false;

      entry.metadata.keywords = entry.metadata.keywords || [];
      if (!entry.metadata.keywords.includes('sharded')) {
        entry.metadata.keywords.push('sharded');
      }

      const shardedEntry: ShardedMemoryIndexEntry = {
        ...entry,
        shardInfo: {
          shardCount: shardYamlFiles.length,
          shardDir: path.join(dateFolder, subDir),
          metadataFile
        }
      };

      this.addToIndex(newIndex, shardedEntry);
      return true;
    } catch (error) {
      logger.warn('Failed to index sharded memory', {
        subDir,
        dateFolder,
        path: path.join(subDirPath, metadataFile),
        metadataFile,
        shardCount: shardYamlFiles.length,
        location: 'sharded-subdirectory',
        error: error instanceof Error ? error.message : String(error),
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        shardFiles: shardYamlFiles.slice(0, 5)
      });
      return false;
    }
  }

  private addBuildStats(target: BuildStats, addition: BuildStats): void {
    target.totalFiles += addition.totalFiles;
    target.processedFiles += addition.processedFiles;
  }

  private updateIndexAtomically(
    namespace: string,
    newIndex: PortfolioIndex,
    stats: BuildStats,
    startTime: number,
  ): void {
    this.indexByNamespace.set(namespace, newIndex);
    this.lastBuiltByNamespace.set(namespace, new Date());

    const duration = Date.now() - startTime;
    logger.info('Portfolio index built successfully', {
      totalFiles: stats.totalFiles,
      processedFiles: stats.processedFiles,
      duration: `${duration}ms`,
      uniqueNames: newIndex.byName.size,
      uniqueKeywords: newIndex.byKeyword.size,
      uniqueTags: newIndex.byTag.size
    });

    SecurityMonitor.logSecurityEvent({
      type: 'PORTFOLIO_INITIALIZATION',
      severity: 'LOW',
      source: 'PortfolioIndexManager.performBuild',
      details: `Portfolio index rebuilt with ${stats.processedFiles} elements in ${duration}ms`
    });
  }

  /**
   * Create an index entry from a file
   */
  private async createIndexEntry(filePath: string, elementType: ElementType): Promise<IndexEntry | null> {
    try {
      // Get file stats
      const stats = await this.fileOperations.stat(filePath);

      // Read file content
      const content = await this.fileOperations.readFile(filePath, { source: 'PortfolioIndexManager.createIndexEntry' });

      // Parse frontmatter securely
      // SECURITY NOTE: Portfolio files are locally trusted content that users
      // have deliberately created or installed. Security validation should focus
      // on BEHAVIORAL analysis during import/installation, not superficial word
      // matching in descriptions. A malicious actor would never label their
      // exploit as "dangerous" - they'd call it "helpful utility".
      // Future: Add behavioral analysis on import, not during indexing.
      const parsed = SecureYamlParser.parse(content, {
        validateContent: false,  // Don't scan for words in trusted local files
        validateFields: false    // Portfolio files are pre-trusted by user choice
      });
      
      // Extract base filename
      const filename = path.basename(filePath, '.md');
      
      // Build metadata with defaults
      const metadata = {
        name: parsed.data.name || filename,
        description: parsed.data.description,
        version: parsed.data.version,
        author: parsed.data.author,
        tags: Array.isArray(parsed.data.tags) ? parsed.data.tags : [],
        keywords: Array.isArray(parsed.data.keywords) ? parsed.data.keywords : [],
        triggers: Array.isArray(parsed.data.triggers) ? parsed.data.triggers : [],
        category: parsed.data.category,
        created: parsed.data.created || parsed.data.created_date,
        updated: parsed.data.updated || parsed.data.updated_date,
        // Issue #749: Carry agent `activates` through to index builder for relationship extraction
        ...(parsed.data.activates && typeof parsed.data.activates === 'object'
          ? { activates: parsed.data.activates as Record<string, string[]> }
          : {})
      };

      const entry: IndexEntry = {
        filePath,
        elementType,
        metadata,
        lastModified: stats.mtime,
        filename
      };
      
      return entry;
      
    } catch (error) {
      logger.debug(`Failed to create index entry for: ${filePath}`, {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Create an index entry from a memory YAML file
   * FIX #1188: Special handling for memory files with different structure
   * FIX #1196: Use yaml.load for pure YAML files, not SecureYamlParser (which expects Markdown frontmatter)
   */
  private async createMemoryIndexEntry(filePath: string, elementType: ElementType): Promise<IndexEntry | null> {
    try {
      // Get file stats
      const stats = await this.fileOperations.stat(filePath);

      // Read file content
      const content = await this.fileOperations.readFile(filePath, { source: 'PortfolioIndexManager.createMemoryIndexEntry' });

      // FIX #1196: Parse pure YAML using yaml.load()
      // Memory files are pure YAML without frontmatter markers, so we can't use SecureYamlParser
      // (which is designed for Markdown files with YAML frontmatter between --- markers)
      // Using FAILSAFE_SCHEMA for security (same as MemoryManager uses)

      // Security validation: Check content size before parsing
      if (content.length > 1048576) { // 1MB limit
        logger.warn(`Large memory file detected, skipping: ${filePath}`);
        return null;
      }

      const rawParsed = yaml.load(content, {
        schema: yaml.FAILSAFE_SCHEMA
      });

      // Type safety: Ensure parsed result is a valid object
      if (!rawParsed || typeof rawParsed !== 'object' || Array.isArray(rawParsed)) {
        logger.warn(`Invalid YAML structure in memory file: ${filePath}`);
        return null;
      }

      const parsed = rawParsed as Record<string, any>;

      // Extract base filename
      const filename = path.basename(filePath, '.yaml');

      // Memory files can have metadata at top level OR nested under 'metadata' key
      // FIX #1196: Merge both levels, preferring nested metadata block over top-level
      // This handles mixed structures where some fields are top-level and others are nested
      const metadataSource = parsed.metadata
        ? { ...parsed, ...parsed.metadata }  // Merge top-level with nested, nested wins
        : parsed;  // No nested metadata, use top-level only

      // Build metadata with memory-specific defaults
      const metadata = {
        name: metadataSource.name || filename.replaceAll('-', ' '),
        description: metadataSource.description || 'Memory element',
        version: metadataSource.version || '1.0.0',
        author: metadataSource.author,
        tags: Array.isArray(metadataSource.tags) ? metadataSource.tags : [],
        keywords: Array.isArray(metadataSource.keywords) ? metadataSource.keywords : [],
        triggers: Array.isArray(metadataSource.triggers) ? metadataSource.triggers : [],
        category: metadataSource.category,
        created: metadataSource.created || metadataSource.created_date,
        updated: metadataSource.updated || metadataSource.updated_date || metadataSource.modified
      };

      const entry: IndexEntry = {
        filePath,
        elementType,
        metadata,
        lastModified: stats.mtime,
        filename
      };

      return entry;

    } catch (error) {
      logger.debug(`Failed to create memory index entry for: ${filePath}`, {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Add entry to all relevant index maps
   */
  private addToIndex(index: PortfolioIndex, entry: IndexEntry): void {
    // Normalize keys for case-insensitive lookup
    const normalizedName = entry.metadata.name.toLowerCase();
    const normalizedFilename = entry.filename.toLowerCase();
    
    // Add to name map
    index.byName.set(normalizedName, entry);
    
    // Add to filename map
    index.byFilename.set(normalizedFilename, entry);
    
    // Add to type map
    const typeEntries = index.byType.get(entry.elementType) || [];
    typeEntries.push(entry);
    index.byType.set(entry.elementType, typeEntries);
    
    // Add keywords
    for (const keyword of entry.metadata.keywords || []) {
      const normalizedKeyword = keyword.toLowerCase();
      const keywordEntries = index.byKeyword.get(normalizedKeyword) || [];
      keywordEntries.push(entry);
      index.byKeyword.set(normalizedKeyword, keywordEntries);
    }
    
    // Add tags
    for (const tag of entry.metadata.tags || []) {
      const normalizedTag = tag.toLowerCase();
      const tagEntries = index.byTag.get(normalizedTag) || [];
      tagEntries.push(entry);
      index.byTag.set(normalizedTag, tagEntries);
    }
    
    // Add triggers
    for (const trigger of entry.metadata.triggers || []) {
      const normalizedTrigger = trigger.toLowerCase();
      const triggerEntries = index.byTrigger.get(normalizedTrigger) || [];
      triggerEntries.push(entry);
      index.byTrigger.set(normalizedTrigger, triggerEntries);
    }
  }

  /**
   * Find fuzzy matches for a name
   */
  private findFuzzyMatch(searchName: string, index: PortfolioIndex, options: SearchOptions): IndexEntry | null {
    const search = searchName.toLowerCase();
    let bestMatch: IndexEntry | null = null;
    let bestScore = 0;
    
    // Search names with partial matching
    for (const [name, entry] of index.byName) {
      if (options.elementType && entry.elementType !== options.elementType) {
        continue;
      }
      
      const score = this.calculateSimilarity(search, name);
      if (score > bestScore && score > 0.3) { // Minimum similarity threshold
        bestScore = score;
        bestMatch = entry;
      }
    }
    
    // Also check filenames
    for (const [filename, entry] of index.byFilename) {
      if (options.elementType && entry.elementType !== options.elementType) {
        continue;
      }
      
      const score = this.calculateSimilarity(search, filename);
      if (score > bestScore && score > 0.3) {
        bestScore = score;
        bestMatch = entry;
      }
    }
    
    return bestMatch;
  }

  /**
   * Calculate similarity between two strings
   */
  private calculateSimilarity(a: string, b: string): number {
    // Simple similarity based on substring containment and length
    if (a === b) return 1.0;
    if (a.includes(b) || b.includes(a)) return 0.8;
    
    // Check for word overlap
    const wordsA = a.split(/\s+/);
    const wordsB = b.split(/\s+/);
    const commonWords = wordsA.filter(word => wordsB.includes(word));
    
    if (commonWords.length > 0) {
      return commonWords.length / Math.max(wordsA.length, wordsB.length);
    }
    
    return 0;
  }

  /**
   * Check if any query tokens match the text
   */
  private matchesQuery(text: string, queryTokens: string[]): boolean {
    return queryTokens.some(token => text.includes(token));
  }

  /**
   * Dispose internal state to release resources (used during shutdown/tests).
   */
  public dispose(): void {
    this.indexByNamespace.clear();
    this.lastBuiltByNamespace.clear();
    this.buildingByNamespace.clear();
  }


}
